import { execFileSync } from 'node:child_process'
import { access, appendFile, cp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BhError } from './client.ts'

/**
 * What `bh setup` does once the plugin is installed: the working directory from the template, and
 * `bh` on the PATH of the person's own terminal (Claude Code already puts the plugin's bin/ on its
 * shell's). It runs as `node <plugin>/cli/cli.ts setup`, so the agent that sets a teammate up never
 * has to download and run a script — which its permission check refuses. Each part checks first,
 * so a second run changes nothing.
 */
export async function setup(dir?: string) {
  const { bin, workspace: template } = await layout()
  const target = resolve(dir ?? join(homedir(), 'work', 'belkins-home'))
  let workspace: 'created' | 'kept'
  if (await exists(join(target, 'CLAUDE.md'))) workspace = 'kept'
  else {
    await mkdir(target, { recursive: true })
    await cp(template, target, { recursive: true })
    workspace = 'created'
  }
  const path = process.platform === 'win32' ? windowsPath(bin) : await posixPath(bin)
  return { workspace: target, [workspace]: true, path, next: 'bh login' }
}

/** Where bin/ and the workspace template are: the published plugin, or the platform repository. */
async function layout() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    { bin: join(here, '..', 'bin'), workspace: join(here, '..', '..', 'workspace') },
    {
      bin: join(here, '..', '..', '..', 'plugin', 'bin'),
      workspace: join(here, '..', '..', '..', 'distribution', 'workspace'),
    },
  ]
  for (const found of candidates)
    if ((await exists(join(found.bin, 'bh'))) && (await exists(found.workspace))) return found
  throw new BhError('bh setup: no plugin around this CLI', {
    hint: 'Install the plugin first: claude plugin install belkins-home@belkins-home',
  })
}

/** A link in ~/.local/bin, and that directory on the PATH of the login shell's rc file. */
async function posixPath(bin: string) {
  const dir = join(homedir(), '.local', 'bin')
  const link = join(dir, 'bh')
  await mkdir(dir, { recursive: true })
  await rm(link, { force: true })
  await symlink(join(bin, 'bh'), link)
  const rc = join(homedir(), basename(process.env.SHELL ?? '') === 'zsh' ? '.zshrc' : '.bashrc')
  const line = 'export PATH="$HOME/.local/bin:$PATH"'
  const text = await readFile(rc, 'utf8').catch(() => '')
  if (!text.includes(line)) await appendFile(rc, `\n${line}\n`)
  return { link, rc, newTerminal: !(process.env.PATH ?? '').split(':').includes(dir) }
}

/** The plugin's bin/ (with bh.cmd) on the user's PATH, which every new terminal reads. */
function windowsPath(bin: string) {
  const ps = (script: string) =>
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim()
  const current = ps("[Environment]::GetEnvironmentVariable('Path', 'User')")
  const entries = current.split(';').filter(Boolean)
  const added = !entries.some((entry) => entry.toLowerCase() === bin.toLowerCase())
  if (added) {
    const next = [...entries, bin].join(';').replaceAll("'", "''")
    ps(`[Environment]::SetEnvironmentVariable('Path', '${next}', 'User')`)
  }
  return { userPath: bin, added, newTerminal: true }
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}
