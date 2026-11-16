import type { BhConfig } from './config.ts'

export class BhError extends Error {
  readonly payload: unknown
  readonly exitCode: number
  /** The engine's HTTP status; none when no answer came back. */
  readonly status: number | undefined
  /** The request may have landed: it was sent, and no answer came back (a timeout, a dropped connection). */
  readonly unsure: boolean
  constructor(
    message: string,
    payload: unknown,
    exitCode = 1,
    more: { status?: number; unsure?: boolean } = {},
  ) {
    super(message)
    this.payload = payload
    this.exitCode = exitCode
    this.status = more.status
    this.unsure = more.unsure ?? false
  }
}

/** How long bh waits before it asks a read again. */
const RETRY_AFTER_MS = Number(process.env.BH_RETRY_AFTER_MS ?? 2000)

/**
 * How long bh waits for an answer before it gives up: two minutes, or BH_TIMEOUT_MS. A hung engine
 * would otherwise hold an agent for undici's five minutes, twice for a read it asks again.
 */
const TIMEOUT_MS = Number(process.env.BH_TIMEOUT_MS) || 120_000

/**
 * Requests known to take long, given ten minutes: a call through to a provider or a client's CRM,
 * a CRM's activity pass, a CSV the engine builds from a whole project.
 */
const SLOW = [
  /^\/providers\/[^/]+\/call$/,
  /\/crm\/[^/]+\/(call|activity)$/,
  /\/csv$/,
  /^\/projects\/[^/]+\/activity\?/,
]
const SLOW_MS = Math.max(TIMEOUT_MS, 600_000)

/** The timeout for a path: a slow one's, or the default. */
export const timeoutFor = (path: string) => (SLOW.some((r) => r.test(path)) ? SLOW_MS : TIMEOUT_MS)

/** How much of an answer that is not JSON (a proxy's HTML page) an error carries. */
const SHOWN = 300

/** A request that changes nothing: a GET, or a read-only query to POST /sql. */
const onlyReads = (method: string, path: string) => method === 'GET' || path === '/sql'

type Options = {
  /** Sent without a token — a login starts before there is one, and a stale one would be refused. */
  anonymous?: boolean
  /** Overrides the path's timeout. */
  timeoutMs?: number
  /** Sent as JSON. */
  body?: unknown
  accept?: string
}

/** The engine's address and the token, as the config gives them (loadConfig, then the flags). */
function target(config: BhConfig, anonymous: boolean) {
  if (!config.api) throw new BhError('No API set', { hint: 'bh login' }, 2)
  return {
    api: config.api.replace(/\/+$/, ''),
    token: anonymous ? undefined : config.token,
  }
}

/** One fetch, its failure to connect or to answer in time turned into a BhError that says which. */
async function send(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError'
    const cause = (error as Error & { cause?: Error & { code?: string } }).cause
    // Refused or never found: nothing was sent, so nothing can have landed.
    const unsent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause?.code ?? '')
    throw new BhError(
      timedOut
        ? `${what} → no answer in ${Math.round(timeoutMs / 100) / 10} s`
        : `${what} → could not reach the engine`,
      {
        error: timedOut
          ? 'timeout'
          : [(error as Error).message, cause?.message].filter(Boolean).join(': '),
        hint: timedOut
          ? 'The engine may still be working on it: check before running a write again (BH_TIMEOUT_MS waits longer)'
          : 'Check the connection and the API address (bh whoami); during a deploy, run it again in a minute',
      },
      1,
      // A write that was sent may have landed whether or not its answer came back.
      { unsure: init.method !== undefined && init.method !== 'GET' && !unsent },
    )
  }
}

/**
 * A request that only reads is asked once more when the engine fails on its side (a 5xx) or the
 * connection drops: a deploy's last moments answer so for a few seconds, and a scheduled run that
 * gave up at the first one would stop for nothing (belkins-home-plugin#88). A write is never sent
 * twice — it may have landed. A read that timed out is not asked again: a hung engine stays hung.
 */
async function sendRead(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number,
  reads: boolean,
): Promise<Response> {
  if (!reads) return send(url, init, what, timeoutMs)
  try {
    const first = await send(url, init, what, timeoutMs)
    if (![500, 502, 503, 504].includes(first.status)) return first
    await first.arrayBuffer().catch(() => {})
  } catch (error) {
    if (error instanceof BhError && (error.payload as { error?: string }).error === 'timeout')
      throw error
    // The connection dropped or was refused: ask once more below, and let that one's error stand.
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS))
  return send(url, init, what, timeoutMs)
}

/**
 * The engine's refusal as it wrote it, or — when the answer is not JSON (a proxy's 502 page during
 * a deploy) — its status and the start of what came back.
 */
function refusal(what: string, response: Response, text: string): BhError {
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = {
      status: response.status,
      body: text.slice(0, SHOWN),
      hint:
        response.status >= 500
          ? 'The engine or its proxy failed; during a deploy, run it again in a minute'
          : undefined,
    }
  }
  return new BhError(`${what} → ${response.status}`, payload, 1, { status: response.status })
}

/** An answer's body; its timeout running out while it streams in is said like any other. */
async function bodyOf<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    throw new BhError(
      `${what} → the answer stopped coming`,
      {
        error: (error as Error).name === 'TimeoutError' ? 'timeout' : (error as Error).message,
        hint: 'The engine took it; check before running a write again (BH_TIMEOUT_MS waits longer)',
      },
      1,
      { unsure: true },
    )
  }
}

/** One request to the engine: the answer as a Response once it is known to be a success. */
export async function request(
  config: BhConfig,
  method: string,
  path: string,
  options: Options = {},
): Promise<Response> {
  const { api, token } = target(config, options.anonymous ?? false)
  const headers: Record<string, string> = { accept: options.accept ?? 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const what = `${method} ${path}`
  // Joined as text, not new URL(path, api): an absolute path would drop a prefix such as the web
  // app's /api, and the request would land on its HTML instead of the engine.
  const response = await sendRead(
    `${api}${path}`,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    what,
    options.timeoutMs ?? timeoutFor(path),
    onlyReads(method, path),
  )
  if (response.ok) return response
  throw refusal(what, response, await response.text().catch(() => ''))
}

/** One request to the engine, its JSON answer; errors come back verbatim, as the API wrote them. */
export async function call(
  config: BhConfig,
  method: string,
  path: string,
  body?: unknown,
  options: Omit<Options, 'body'> = {},
): Promise<unknown> {
  const response = await request(config, method, path, { ...options, body })
  const text = await bodyOf(`${method} ${path}`, () => response.text())
  try {
    return text ? (JSON.parse(text) as unknown) : null
  } catch {
    throw new BhError(
      `${method} ${path} → ${response.status}, but not JSON`,
      {
        status: response.status,
        body: text.slice(0, SHOWN),
        hint: 'The API address may point at a web page rather than the engine: bh whoami',
      },
      1,
      { status: response.status },
    )
  }
}

/** A request whose answer is a file, not JSON (a call list's CSV); errors still come back as JSON. */
export async function callText(config: BhConfig, path: string): Promise<string> {
  const response = await request(config, 'GET', path, { accept: '*/*' })
  return bodyOf(`GET ${path}`, () => response.text())
}

/** A request whose answer is a file of any kind (a reply's attachment), with the name it was sent under. */
export async function callFile(
  config: BhConfig,
  path: string,
): Promise<{ name: string | null; type: string; content: Buffer }> {
  const response = await request(config, 'GET', path, { accept: '*/*' })
  const named = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')
  return {
    name: named?.[1] ? decodeURIComponent(named[1]) : null,
    type: response.headers.get('content-type') ?? 'application/octet-stream',
    content: Buffer.from(await bodyOf(`GET ${path}`, () => response.arrayBuffer())),
  }
}
