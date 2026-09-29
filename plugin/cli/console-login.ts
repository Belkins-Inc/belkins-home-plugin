import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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

// The little of Playwright used here: bh does not depend on it, so its types are not at hand.
type Page = {
  goto(url: string): Promise<unknown>
  url(): string
  waitForTimeout(ms: number): Promise<void>
}
type Context = { newPage(): Promise<Page>; storageState(): Promise<unknown> }
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
  const proxy = new URL(login.proxy)
  const { chromium } = await playwright(log)
  let browser: Browser
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
      proxy: {
        server: `${proxy.protocol}//${proxy.host}`,
        username: decodeURIComponent(proxy.username),
        password: decodeURIComponent(proxy.password),
      },
    })
  } catch (error) {
    throw new BhError(
      'Google Chrome could not be started',
      { hint: 'Install Google Chrome, then run this again', detail: String(error) },
      2,
    )
  }
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  await page.goto(PAGE)
  log(`Sign in as ${login.adminEmail} in the window that opened (tenant ${login.tenant}).`)
  const deadline = Date.now() + 15 * 60_000
  try {
    while (Date.now() < deadline) {
      const url = page.url()
      if (url.startsWith('https://admin.google.com/') && !/ServiceLogin|signin/.test(url)) {
        await page.waitForTimeout(5000)
        const session = await context.storageState()
        return await call(config, 'PUT', `/tenants/${tenantId}/console-session`, { session })
      }
      await page.waitForTimeout(2000)
    }
    throw new BhError('Nobody signed in within 15 minutes', { hint: 'Run it again' }, 2)
  } finally {
    await browser.close()
  }
}
