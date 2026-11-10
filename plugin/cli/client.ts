import type { BhConfig } from './config.ts'

export class BhError extends Error {
  readonly payload: unknown
  readonly exitCode: number
  constructor(message: string, payload: unknown, exitCode = 1) {
    super(message)
    this.payload = payload
    this.exitCode = exitCode
  }
}

/** How long bh waits before it asks a read again. */
const RETRY_AFTER_MS = Number(process.env.BH_RETRY_AFTER_MS ?? 2000)

/**
 * A request that only reads is asked once more when the engine fails on its side (a 5xx) or the
 * connection drops: a deploy's last moments answer so for a few seconds, and a scheduled run that
 * gave up at the first one would stop for nothing (belkins-home-plugin#88). A write is never sent
 * twice — it may have landed.
 */
async function fetchRead(url: string, init: RequestInit, reads: boolean): Promise<Response> {
  if (!reads) return fetch(url, init)
  try {
    const first = await fetch(url, init)
    if (![500, 502, 503, 504].includes(first.status)) return first
    await first.arrayBuffer()
  } catch {
    // The connection dropped or was refused: ask once more below, and let that one's error stand.
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS))
  return fetch(url, init)
}

/** A request that changes nothing: a GET, or a read-only query to POST /sql. */
const onlyReads = (method: string, path: string) => method === 'GET' || path === '/sql'

/** One request to the engine; errors come back verbatim, as the API wrote them. */
export async function call(
  config: BhConfig,
  method: string,
  path: string,
  body?: unknown,
  /** Sent without a token — a login starts before there is one, and a stale one would be refused. */
  anonymous = false,
): Promise<unknown> {
  const api = process.env.BH_API || config.api
  if (!api) throw new BhError('No API set', { hint: 'bh login' }, 2)
  const token = anonymous ? undefined : process.env.BH_TOKEN || config.token
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  // Joined as text, not new URL(path, api): an absolute path would drop a prefix such as the web
  // app's /api, and the request would land on its HTML instead of the engine.
  const response = await fetchRead(
    `${api.replace(/\/+$/, '')}${path}`,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    onlyReads(method, path),
  )
  const text = await response.text()
  const payload = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) throw new BhError(`${method} ${path} → ${response.status}`, payload)
  return payload
}

/** A request whose answer is a file, not JSON (a call list's CSV); errors still come back as JSON. */
export async function callText(config: BhConfig, path: string): Promise<string> {
  const api = process.env.BH_API || config.api
  if (!api) throw new BhError('No API set', { hint: 'bh login' }, 2)
  const token = process.env.BH_TOKEN || config.token
  const response = await fetchRead(
    `${api.replace(/\/+$/, '')}${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
    true,
  )
  const text = await response.text()
  if (!response.ok)
    throw new BhError(
      `GET ${path} → ${response.status}`,
      text ? (JSON.parse(text) as unknown) : null,
    )
  return text
}

/** A request whose answer is a file of any kind (a reply's attachment), with the name it was sent under. */
export async function callFile(
  config: BhConfig,
  path: string,
): Promise<{ name: string | null; type: string; content: Buffer }> {
  const api = process.env.BH_API || config.api
  if (!api) throw new BhError('No API set', { hint: 'bh login' }, 2)
  const token = process.env.BH_TOKEN || config.token
  const response = await fetchRead(
    `${api.replace(/\/+$/, '')}${path}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
    true,
  )
  if (!response.ok) {
    const text = await response.text()
    throw new BhError(
      `GET ${path} → ${response.status}`,
      text ? (JSON.parse(text) as unknown) : null,
    )
  }
  const named = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')
  return {
    name: named?.[1] ? decodeURIComponent(named[1]) : null,
    type: response.headers.get('content-type') ?? 'application/octet-stream',
    content: Buffer.from(await response.arrayBuffer()),
  }
}
