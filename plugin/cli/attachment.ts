import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { BhError } from './client.ts'

// A file a lead sent, saved where the agent reading it can open it. Its name is the sender's to
// choose, so it never lands beside the files the agent works by: one named CLAUDE.md, saved in the
// working directory under its own name, replaced the project's instructions with the sender's
// (2026-11-15 audit, H2).

/** Where `bh thread attachment` saves, under the working directory: a folder of each message's. */
export const ATTACHMENTS_DIR = 'bh-attachments'

/**
 * Where file `n` of a message is saved: `bh-attachments/<message-id>/<n>-<its name>`. The name is
 * cut to its last part (no `../`), and the number before it keeps it from being taken for a file
 * Claude Code reads by name (a CLAUDE.md in a folder is read with the folder).
 */
export function attachmentPath(messageId: string, n: string, name: string | null): string {
  if (!/^[1-9]\d*$/.test(n))
    throw new BhError(
      `${n} is not a file's number`,
      { hint: 'bh thread attachments <message-id> lists them, from 1' },
      2,
    )
  const own = basename((name ?? '').replace(/\\/g, '/')).trim()
  const safe = own && own !== '.' && own !== '..' ? own : 'attachment'
  return join(ATTACHMENTS_DIR, basename(messageId), `${n}-${safe}`)
}

/** Writes a file that must not be there yet: an existing one is refused, never replaced. */
export async function saveNew(path: string, content: Buffer) {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, content, { flag: 'wx' })
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    throw new BhError(
      `${path} is already there`,
      { hint: 'It was saved before; read that one, or pass --out <new file>' },
      2,
    )
  }
}
