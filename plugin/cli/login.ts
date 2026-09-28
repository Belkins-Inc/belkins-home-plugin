import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { BhError, call } from './client.ts'
import { CONFIG_PATH, type BhConfig } from './config.ts'

// `bh login` without a token: the engine's device flow. bh starts a login and prints a link; the
// person opens it, signs in with Google and approves; bh collects its token.
//
// An agent sees a command's output only when the command ends, so without a terminal the two
// halves are two commands: `bh login` prints the link and exits, `bh login --wait` collects. In a
// terminal `bh login` does both.

/** Production, where client work happens (docs/onboarding.md, "Which engine"). */
export const DEFAULT_API = 'https://home-next.belkins.io/api'

const PENDING_PATH = join(dirname(CONFIG_PATH), 'login.json')

type Started = {
  deviceCode: string
  userCode: string
  verificationUrl: string | null
  expiresAt: string
  interval: number
}
type Pending = {
  api: string
  deviceCode: string
  link: string
  expiresAt: string
  interval: number
}

/** The web app's link for a code: the engine's, or the API address without its /api. */
export function linkFor(api: string, started: Pick<Started, 'userCode' | 'verificationUrl'>) {
  return (
    started.verificationUrl ??
    `${api.replace(/\/+$/, '').replace(/\/api$/, '')}/cli/${started.userCode}`
  )
}

/** Starts a login; the secret stays on disk beside the config until it is collected. */
export async function startLogin(api: string, openBrowser: boolean): Promise<Pending> {
  const started = (await call(
    { api },
    'POST',
    '/auth/cli',
    { clientName: hostname() },
    true,
  )) as Started
  const pending: Pending = {
    api,
    deviceCode: started.deviceCode,
    link: linkFor(api, started),
    expiresAt: started.expiresAt,
    interval: started.interval,
  }
  await mkdir(dirname(PENDING_PATH), { recursive: true })
  await writeFile(PENDING_PATH, `${JSON.stringify(pending)}\n`, { mode: 0o600 })
  if (openBrowser) open(pending.link)
  return pending
}

/** Polls until the person approves; saves the token and forgets the login. */
export async function waitForLogin(config: BhConfig): Promise<BhConfig & { email: string }> {
  let pending: Pending
  try {
    pending = JSON.parse(await readFile(PENDING_PATH, 'utf8')) as Pending
  } catch {
    throw new BhError('No login to wait for', { hint: 'Run bh login first' }, 2)
  }
  const deadline = new Date(pending.expiresAt).getTime()
  for (;;) {
    let answer: { status: 'pending' } | { status: 'approved'; token: string; email: string }
    try {
      answer = (await call(
        { api: pending.api },
        'POST',
        '/auth/cli/token',
        { deviceCode: pending.deviceCode },
        true,
      )) as typeof answer
    } catch (error) {
      // Expired, already used or unknown: this login is over either way.
      if (error instanceof BhError) await rm(PENDING_PATH, { force: true })
      throw error
    }
    if (answer.status === 'approved') {
      await rm(PENDING_PATH, { force: true })
      return { ...config, api: pending.api, token: answer.token, email: answer.email }
    }
    if (Date.now() > deadline + 5_000)
      throw new BhError('The link expired before it was approved', { hint: 'Run bh login again' })
    await new Promise((r) => setTimeout(r, pending.interval * 1000))
  }
}

/** Opens the link in the person's browser where there is one; a failure is only a missed shortcut. */
function open(link: string) {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
        ? 'xdg-open'
        : null
  if (!command) return
  try {
    spawn(command, [link], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref()
  } catch {
    // No browser to open; the link is printed anyway.
  }
}
