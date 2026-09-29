import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { BhError, call } from './client.ts'
import { CONFIG_PATH, type BhConfig } from './config.ts'

// `bh tenant console-login <id>`: a person signs in to the Google Admin console once, through the
// console service's own static IP, and the session goes to the engine for the service to work with
// (docs/decisions/infrastructure.md, "DKIM"). Signed in from anywhere else, Google would ask the
// service to sign in again the first time it used the session.

const PLAYWRIGHT = '1.63.0'
const PAGE = 'https://admin.google.com/ac/apps/gmail/authenticateemail'
// Signed out, admin.google.com sends the browser through www.google.com, which the proxy refuses;
// the sign-in page itself does not.
const SIGN_IN = `https://accounts.google.com/ServiceLogin?service=CPanel&continue=${encodeURIComponent(PAGE)}`

/**
 * A local forward proxy in front of Bright Data: credentials up front (it closes the connection on
 * its 407, which Chrome does not retry), and www.google.com — refused on ISP networks, and fatal to
 * the proxy in Chrome's eyes — answered with a tunnel that closes at once. The console service
 * carries the same (apps/console/src/tunnel.ts).
 */
function startTunnel(upstreamUrl: string): Promise<{ url: string; close: () => void }> {
  const up = new URL(upstreamUrl)
  const auth = `Basic ${Buffer.from(
    `${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`,
  ).toString('base64')}`
  const server = net.createServer((client) => {
    client.on('error', () => {})
    client.once('data', (head: Buffer) => {
      const target = /^CONNECT ([^:\s]+):(\d+) HTTP/.exec(head.toString('latin1'))
      if (!target) return void client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      const [, host, port] = target as unknown as [string, string, string]
      if (host === 'www.google.com')
        return void client.end('HTTP/1.1 200 Connection Established\r\n\r\n')
      const upstream = net.connect(Number(up.port), up.hostname, () =>
        upstream.write(
          `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: ${auth}\r\n\r\n`,
        ),
      )
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      let answer = Buffer.alloc(0)
      const onAnswer = (chunk: Buffer) => {
        answer = Buffer.concat([answer, chunk])
        const end = answer.indexOf('\r\n\r\n')
        if (end < 0) return
        upstream.off('data', onAnswer)
        if (!/^HTTP\/1\.[01] 200/.test(answer.toString('latin1'))) {
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          return void upstream.destroy()
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const rest = answer.subarray(end + 4)
        if (rest.length) client.write(rest)
        client.pipe(upstream).pipe(client)
      }
      upstream.on('data', onAnswer)
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    }),
  )
}

// The little of Playwright used here: bh does not depend on it, so its types are not at hand.
type Page = {
  innerText(selector: string): Promise<string>
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  url(): string
  waitForTimeout(ms: number): Promise<void>
}
type Context = {
  newPage(): Promise<Page>
  storageState(): Promise<unknown>
  cookies(): Promise<{ name: string; domain: string }[]>
}
type Browser = { newContext(o: object): Promise<Context>; close(): Promise<void> }
type Playwright = { chromium: { launch(o: object): Promise<Browser> } }

/** Playwright is large and only this command needs it: it is installed beside bh's config once. */
async function playwright(log: (line: string) => void) {
  const dir = join(dirname(CONFIG_PATH), 'console')
  const require = createRequire(join(dir, 'package.json'))
  if (!existsSync(join(dir, 'node_modules', 'playwright'))) {
    log(`Installing Playwright ${PLAYWRIGHT} into ${dir} (once)…`)
    await mkdir(dir, { recursive: true })
    await promisify(execFile)(
      'npm',
      ['install', '--prefix', dir, '--no-save', '--silent', `playwright@${PLAYWRIGHT}`],
      // The installed Google Chrome is used; nothing else to download.
      { env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } },
    )
  }
  return require('playwright') as Playwright
}

export async function consoleLogin(config: BhConfig, tenantId: string) {
  const log = (line: string) => process.stderr.write(`${line}\n`)
  const login = (await call(config, 'GET', `/tenants/${tenantId}/console-login`)) as {
    tenant: string
    adminEmail: string
    proxy: string
  }
  const { chromium } = await playwright(log)
  const tunnel = await startTunnel(login.proxy)
  let browser: Browser
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
      proxy: { server: tunnel.url },
    })
  } catch (error) {
    tunnel.close()
    throw new BhError(
      'Google Chrome could not be started',
      { hint: 'Install Google Chrome, then run this again', detail: String(error) },
      2,
    )
  }
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  // Through the proxy the console takes long to finish loading; the address is what is watched.
  await page.goto(SIGN_IN, { waitUntil: 'commit', timeout: 120_000 }).catch(() => {})
  log(
    `Sign in in the window that opened (tenant ${login.tenant}) as an admin who may change Gmail settings — the console robot, or ${login.adminEmail}.`,
  )
  const deadline = Date.now() + 15 * 60_000
  try {
    while (Date.now() < deadline) {
      const url = page.url()
      if (url.startsWith('https://admin.google.com/') && !/ServiceLogin|signin/.test(url)) {
        await page.waitForTimeout(5000)
        // The session is only worth keeping if it opens the page the console service works on.
        if (!url.startsWith(PAGE))
          await page.goto(PAGE, { waitUntil: 'commit', timeout: 120_000 }).catch(() => {})
        await page.waitForTimeout(8000)
        const text = await page.innerText('body').catch(() => '')
        if (!/DKIM authentication/i.test(text))
          throw new BhError(
            'Signed in, but this account cannot open Authenticate email',
            {
              hint: 'Give its admin role Services → Gmail → Settings (or sign in as a super admin), then run this again',
              page: text.replace(/\s+/g, ' ').slice(0, 300),
            },
            2,
          )
        const session = await context.storageState()
        return await call(config, 'PUT', `/tenants/${tenantId}/console-session`, { session })
      }
      // Signed in, but the redirect back went through www.google.com and stopped: go straight on.
      const signedIn = (await context.cookies()).some((c) => c.name === 'SID')
      if (signedIn && !url.startsWith('https://accounts.google.com/'))
        await page.goto(PAGE, { waitUntil: 'commit', timeout: 120_000 }).catch(() => {})
      await page.waitForTimeout(2000)
    }
    throw new BhError('Nobody signed in within 15 minutes', { hint: 'Run it again' }, 2)
  } finally {
    await browser.close()
    tunnel.close()
  }
}
