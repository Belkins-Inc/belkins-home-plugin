import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

import { BhError, call } from './client.ts'
import { CONFIG_PATH, type BhConfig } from './config.ts'

// `bh linkedin open <id>`: a managed LinkedIn account's browser on the person's own computer — their
// own Google Chrome, through the account's IP, with the account's cookies — for what the remote
// browser cannot pass. LinkedIn's sign-up reCAPTCHA rejected the remote browser's answer however it
// was solved (2026-11-12): a Chrome on a server, drawing without a GPU, driven over the DevTools
// protocol. Here nothing drives the pages: the DevTools pipe is used only to put the cookies in at
// the start and read them back, which never attaches to a page.

export type Proxy = { host: string; port: number; username: string; password: string }

/** A cookie as the engine keeps it (Playwright's storage state). */
export type Cookie = {
  name: string
  value: string
  domain: string
  path: string
  /** Seconds since the epoch; -1 for a session cookie. */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

/** A cookie as Chrome's DevTools protocol gives it (Network.Cookie). */
export type ChromeCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export const fromChrome = (c: ChromeCookie): Cookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  expires: c.session || c.expires <= 0 ? -1 : c.expires,
  httpOnly: c.httpOnly,
  secure: c.secure,
  sameSite: c.sameSite ?? 'Lax',
})

/** What Storage.setCookies takes: a session cookie has no expiry. */
export const toChrome = (c: Cookie) => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  httpOnly: c.httpOnly,
  secure: c.secure,
  sameSite: c.sameSite,
  ...(c.expires > 0 ? { expires: c.expires } : {}),
})

/** The value of the account's LinkedIn session cookie, if the cookies hold one. */
export const liAt = (cookies: Cookie[]) =>
  cookies.find((c) => c.name === 'li_at' && /(^|\.)linkedin\.com$/.test(c.domain))?.value ?? null

/** Where Google Chrome is on this computer: `--chrome` when given, else where it installs itself. */
export function findChrome(given?: string): string {
  const candidates = given
    ? [given]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [
            join(
              process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
              'Google\\Chrome\\Application\\chrome.exe',
            ),
            join(
              process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
              'Google\\Chrome\\Application\\chrome.exe',
            ),
            join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
  const found = candidates.find((path) => existsSync(path))
  if (!found)
    throw new BhError(
      'Google Chrome is not installed where bh looks for it',
      {
        looked: candidates,
        hint: 'Install Google Chrome, or name it: --chrome <path to its binary>',
      },
      2,
    )
  return found
}

/**
 * A local forward proxy in front of the account's: Chrome takes no proxy login on its command line,
 * so it talks to this one without, and the login is added to every request and tunnel on the way.
 * apps/browser does the same for the remote browser (apps/browser/src/tunnel.ts).
 */
export function startTunnel(upstream: Proxy): Promise<{ url: string; close: () => void }> {
  const auth = `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64')}`
  const sockets = new Set<net.Socket>()
  const server = http.createServer((request, response) => {
    const forwarded = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, 'proxy-authorization': auth },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      },
    )
    forwarded.on('error', () => response.destroy())
    request.pipe(forwarded)
  })
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    const target = request.url ?? ''
    const up = net.connect(upstream.port, upstream.host, () =>
      up.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`,
      ),
    )
    sockets.add(up)
    up.on('close', () => sockets.delete(up))
    up.on('error', () => client.destroy())
    client.on('close', () => up.destroy())
    let answer = Buffer.alloc(0)
    const onAnswer = (chunk: Buffer) => {
      answer = Buffer.concat([answer, chunk])
      const end = answer.indexOf('\r\n\r\n')
      if (end < 0) return
      up.off('data', onAnswer)
      if (!/^HTTP\/1\.[01] 200/.test(answer.toString('latin1'))) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return void up.destroy()
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const rest = answer.subarray(end + 4)
      if (rest.length) client.write(rest)
      if (head.length) up.write(head)
      client.pipe(up).pipe(client)
    }
    up.on('data', onAnswer)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const socket of sockets) socket.destroy()
          server.close()
        },
      })
    }),
  )
}

/**
 * Chrome's DevTools protocol over the pipe `--remote-debugging-pipe` opens (its fds 3 and 4):
 * nothing listens on a port a page could find. Only the browser's own domains are spoken to.
 */
class Pipe {
  private next = 1
  private buffer = ''
  private waiting = new Map<
    number,
    (m: { result?: unknown; error?: { message: string } }) => void
  >()
  private readonly out: Writable

  constructor(out: Writable, input: Readable) {
    this.out = out
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      this.buffer += chunk
      let end: number
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(this.buffer.slice(0, end)) as {
          id?: number
          result?: unknown
          error?: { message: string }
        }
        this.buffer = this.buffer.slice(end + 1)
        if (message.id === undefined) continue
        this.waiting.get(message.id)?.(message)
        this.waiting.delete(message.id)
      }
    })
    input.on('close', () => {
      for (const done of this.waiting.values()) done({ error: { message: 'Chrome closed' } })
      this.waiting.clear()
    })
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) =>
        m.error ? reject(new Error(m.error.message)) : resolve(m.result as T),
      )
      this.out.write(`${JSON.stringify({ id, method, params })}\0`, (error) => {
        if (error) {
          this.waiting.delete(id)
          reject(error)
        }
      })
    })
  }
}

type Opening = {
  name: string
  ip: string
  proxy: Proxy
  timezoneId: string | null
  storageState: { cookies?: Cookie[] } | null
  startUrl: string
}

const POLL_MS = 3000
/** Changed cookies are sent at most this often while the person works; a new session at once. */
const SEND_MS = 60_000

export async function linkedinOpen(config: BhConfig, id: string, chromePath?: string) {
  const log = (line: string) => process.stderr.write(`${line}\n`)
  const path = `/linkedin-accounts/${encodeURIComponent(id)}/local-browser`
  const chrome = findChrome(chromePath)
  const opening = (await call(config, 'POST', path, {})) as Opening

  // A profile of the account's own on this computer, kept between runs: the same device each time.
  const profile = join(dirname(CONFIG_PATH), 'linkedin', id.replace(/[^a-z0-9-]/gi, ''))
  if (!existsSync(join(profile, 'Default', 'Preferences'))) {
    await mkdir(join(profile, 'Default'), { recursive: true })
    // The languages a browser in the account's country sends (Accept-Language).
    await writeFile(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ intl: { accept_languages: 'en-US,en' } }),
    )
  }

  const tunnel = await startTunnel(opening.proxy)
  const child: ChildProcess = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      `--proxy-server=${tunnel.url}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      // WebRTC would otherwise reach out over UDP from this computer's own address, past the proxy.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--lang=en-US',
      'about:blank',
    ],
    {
      // The clock of the place the IP is in: a browser in New York on a Kyiv clock is not a person's.
      env: { ...process.env, ...(opening.timezoneId ? { TZ: opening.timezoneId } : {}) },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    },
  )
  let exited = false
  const exit = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true
      resolve()
    }),
  )
  child.once('error', () => {})
  const pipe = new Pipe(child.stdio[3] as Writable, child.stdio[4] as Readable)

  const fail = async (message: string, details: object) => {
    child.kill()
    tunnel.close()
    return new BhError(message, details, 2)
  }

  let userAgent: string
  try {
    ;({ userAgent } = await Promise.race([
      pipe.send<{ userAgent: string }>('Browser.getVersion'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer')), 20_000)),
    ]))
  } catch (error) {
    throw await fail('Google Chrome did not start for this account', {
      detail: String(error),
      hint: `A Chrome of this account may still be open: close it, then run this again (profile ${profile})`,
    })
  }

  const cookies = opening.storageState?.cookies ?? []
  if (cookies.length) await pipe.send('Storage.setCookies', { cookies: cookies.map(toChrome) })
  // The account's page in a tab of its own, the blank one Chrome started with closed: no page is
  // ever attached to, so nothing on it can tell a debugger is there.
  const blank = (
    await pipe.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets')
  ).targetInfos.filter((t) => t.type === 'page')
  await pipe.send('Target.createTarget', { url: opening.startUrl })
  for (const t of blank)
    await pipe.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {})

  log(
    `${opening.name}'s LinkedIn is open in Google Chrome, through ${opening.ip}${opening.timezoneId ? ` (${opening.timezoneId})` : ''}.`,
  )
  log('Work in that window; close it when you are done, and its cookies go to the engine.')

  let last: Cookie[] = cookies
  let sentJson = JSON.stringify(cookies)
  let sentAt = Date.now()
  let sentSession = liAt(cookies)
  const send = async (closed: boolean) => {
    const json = JSON.stringify(last)
    if (!closed && json === sentJson) return null
    const account = await call(config, 'PUT', path, {
      storageState: { cookies: last, origins: [] },
      userAgent,
      closed,
    })
    sentJson = json
    sentAt = Date.now()
    const session = liAt(last)
    if (session && session !== sentSession) log('Signed in to LinkedIn; the session is kept.')
    sentSession = session
    return account
  }

  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    let seenPage = false
    while (!exited && !stopping) {
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, POLL_MS))])
      if (exited) break
      const read = await pipe
        .send<{ cookies: ChromeCookie[] }>('Storage.getCookies')
        .catch(() => null)
      if (read) last = read.cookies.map(fromChrome)
      const pages = await pipe
        .send<{ targetInfos: { type: string }[] }>('Target.getTargets')
        .then((r) => r.targetInfos.filter((t) => t.type === 'page').length)
        .catch(() => 0)
      if (pages) seenPage = true
      // Every window closed: done, though Chrome itself may stay running (as it does on a Mac).
      if (seenPage && !pages) break
      if (liAt(last) !== sentSession || Date.now() - sentAt >= SEND_MS)
        await send(false).catch((error: unknown) => log(`Cookies not sent yet: ${String(error)}`))
    }
    return await send(true)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (!exited) {
      await pipe.send('Browser.close').catch(() => child.kill())
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5000))])
      if (!exited) child.kill()
    }
    tunnel.close()
  }
}
