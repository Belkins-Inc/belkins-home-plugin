import { appendFile, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type BhConfig = { api?: string; token?: string }

export const CONFIG_PATH = process.env.BH_CONFIG ?? join(homedir(), '.config', 'bh', 'config.json')

export async function loadConfig(): Promise<BhConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as BhConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: BhConfig) {
  // A project saved by an older bh is dropped: no project is a default any more.
  const kept: BhConfig = { api: config.api, token: config.token }
  await mkdir(dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })
  await chmod(CONFIG_PATH, 0o600)
}

/**
 * The Claude Code session bh runs in, if any. Parallel sessions each work their own project, so
 * `bh use` inside one is remembered for that session alone — one file per session beside the
 * config, never the shared config (which two sessions would overwrite under each other). Every
 * subagent of a session runs with the session's id: Claude Code gives a subagent none of its own.
 */
export const SESSION = /^[\w-]{1,128}$/.test(process.env.CLAUDE_CODE_SESSION_ID ?? '')
  ? process.env.CLAUDE_CODE_SESSION_ID
  : undefined

const SESSIONS_DIR = join(dirname(CONFIG_PATH), 'sessions')
/** A session's choice is forgotten this long after it was made. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The session's pick: the project it picked last, and every project it picked. Subagents working
 * different clients in parallel share the one file, so a pick can change under an agent between
 * two of its commands; once the session has picked more than one project, the pick names none
 * (cli.ts, currentProject) and each command must name its own.
 */
export type SessionPick = { slug: string; picked: string[] }

export async function loadSessionProject(): Promise<SessionPick | undefined> {
  if (!SESSION) return undefined
  try {
    const lines = (await readFile(join(SESSIONS_DIR, SESSION), 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const slug = lines.at(-1)
    return slug ? { slug, picked: [...new Set(lines)] } : undefined
  } catch {
    return undefined
  }
}

export async function saveSessionProject(slug: string) {
  if (!SESSION) throw new Error('Not in a Claude Code session')
  await mkdir(SESSIONS_DIR, { recursive: true })
  // Appended, never rewritten: two agents picking at the same moment both leave their line, so
  // neither pick is lost and the session is known to work both.
  await appendFile(join(SESSIONS_DIR, SESSION), `${slug}\n`)
  // Sessions end without telling anyone; the files of old ones are swept on the way.
  const now = Date.now()
  for (const name of await readdir(SESSIONS_DIR)) {
    const path = join(SESSIONS_DIR, name)
    const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: now }))
    if (now - mtimeMs > SESSION_TTL_MS) await rm(path, { force: true })
  }
}
