import { readFile } from 'node:fs/promises'

import { BhError } from './client.ts'

/**
 * Reads JSON or JSONL from a file, or from stdin when the path is "-". A `.jsonl` file is always
 * JSONL, so one line of it is a list of one; anything else is JSON, else JSONL.
 */
export async function readInput(path: string): Promise<unknown> {
  const text = path === '-' ? await stdin() : await readFile(path, 'utf8')
  const trimmed = text.trim()
  if (!trimmed) return []
  if (path.endsWith('.jsonl')) return lines(path, trimmed)
  try {
    return JSON.parse(trimmed)
  } catch {
    return lines(path, trimmed)
  }
}

/** The rows a batch command sends: always a list, so a lone object is a list of one. */
export async function readRows(path: string): Promise<unknown[]> {
  const value = await readInput(path)
  return Array.isArray(value) ? value : [value]
}

function lines(path: string, text: string): unknown[] {
  return text.split('\n').flatMap((line, i) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch (error) {
      throw new BhError(
        `${path === '-' ? 'stdin' : path}, line ${i + 1}: not JSON`,
        {
          error: error instanceof Error ? error.message : String(error),
          hint: 'one JSON object per line, or a JSON array',
        },
        2,
      )
    }
  })
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
