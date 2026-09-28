import { BhError, call } from './client.ts'
import type { BhConfig } from './config.ts'

// A file of rows goes in as several requests: the engine takes a body up to 1 MiB and up to 1000
// rows, and a thousand companies with the provider's descriptions in `facts` are a few megabytes.
export const CHUNK_ROWS = 500
export const CHUNK_BYTES = 512 * 1024

/** Rows in chunks of at most `maxRows` and about `maxBytes` of JSON; a larger row goes alone. */
export function chunk(rows: unknown[], maxRows = CHUNK_ROWS, maxBytes = CHUNK_BYTES): unknown[][] {
  const chunks: unknown[][] = []
  let current: unknown[] = []
  let bytes = 2
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1
    if (current.length && (current.length >= maxRows || bytes + size > maxBytes)) {
      chunks.push(current)
      current = []
      bytes = 2
    }
    current.push(row)
    bytes += size
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** The chunks' answers as one: lists join; in objects, counts add up and lists join. */
export function merge(answers: unknown[]): unknown {
  if (answers.length === 1) return answers[0]
  if (answers.every(Array.isArray)) return answers.flat()
  return answers.reduce<Record<string, unknown>>((merged, answer) => {
    for (const [key, value] of Object.entries(answer as Record<string, unknown>)) {
      const was = merged[key]
      merged[key] =
        typeof value === 'number' && typeof was === 'number'
          ? was + value
          : Array.isArray(value) && Array.isArray(was)
            ? [...was, ...value]
            : value
    }
    return merged
  }, {})
}

/**
 * Sends rows in chunks the engine takes and answers as one request would. The first refused chunk
 * stops it, and the refusal says which rows went in before it.
 */
export async function sendRows(
  config: BhConfig,
  path: string,
  rows: unknown[],
  size: { rows?: number; bytes?: number } = {},
): Promise<unknown> {
  const parts = chunk(rows, size.rows, size.bytes)
  const answers: unknown[] = []
  let sent = 0
  for (const part of parts) {
    try {
      answers.push(await call(config, 'POST', path, part))
    } catch (error) {
      if (!(error instanceof BhError) || parts.length === 1) throw error
      throw new BhError(
        error.message,
        {
          ...(error.payload as object),
          rows: `rows ${sent + 1}–${sent + part.length} of ${rows.length} were refused; ${
            sent ? `rows 1–${sent} went in` : 'none went in before them'
          }, the rest were not sent`,
          ...(answers.length ? { wentIn: merge(answers) } : {}),
        },
        error.exitCode,
      )
    }
    sent += part.length
  }
  return merge(answers)
}

/** How many rows an answer that went through still refused: its `refused` count, or rows marked so. */
export function refusedIn(answer: unknown): number {
  if (Array.isArray(answer))
    return answer.filter((r) => r !== null && typeof r === 'object' && 'refused' in r).length
  const refused = (answer as { refused?: unknown } | null)?.refused
  return typeof refused === 'number' ? refused : 0
}
