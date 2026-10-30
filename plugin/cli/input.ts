import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import readline from 'node:readline'

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

/** A text file, or stdin when the path is "-": a report piped straight from another command. */
export const readText = (path: string): Promise<string> =>
  path === '-' ? stdin() : readFile(path, 'utf8')

/**
 * A Slack card's blocks, from a file or stdin: Block Kit Builder's list of blocks, or its whole
 * payload (`{"blocks": [...]}`). What is inside each block is the engine's and Slack's to judge.
 */
export async function readBlocks(path: string): Promise<unknown[]> {
  const text = await readText(path)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BhError(
      `${path === '-' ? 'stdin' : path}: not JSON`,
      { hint: 'Block Kit JSON: a list of blocks, or {"blocks": [...]}' },
      2,
    )
  }
  const blocks = Array.isArray(value) ? value : (value as { blocks?: unknown } | null)?.blocks
  if (!Array.isArray(blocks))
    throw new BhError(
      `${path === '-' ? 'stdin' : path} holds no blocks`,
      { hint: 'Block Kit JSON: a list of blocks, or {"blocks": [...]}' },
      2,
    )
  return blocks
}

/** The rows a batch command sends: always a list, so a lone object is a list of one. */
export async function readRows(path: string): Promise<unknown[]> {
  const value = await readInput(path)
  return Array.isArray(value) ? value : [value]
}

/**
 * Posts as a posts file gives them, each `"images": ["chart.png", …]` read into the files the engine
 * takes ({name, content in base64}), in order. A path is the posts file's folder's unless absolute
 * (stdin's: the working folder's). A file that cannot be read stops it all before any request.
 */
export async function withImages(rows: unknown[], path: string): Promise<unknown[]> {
  const folder = path === '-' ? process.cwd() : dirname(resolve(path))
  return Promise.all(
    rows.map(async (row, i) => {
      const images = (row as { images?: unknown } | null)?.images
      if (images === undefined) return row
      if (!Array.isArray(images) || !images.every((x) => typeof x === 'string' && x))
        throw new BhError(
          `Post ${i + 1}: images is a list of file paths`,
          { hint: '"images": ["chart.png", "photo.jpg"]' },
          2,
        )
      const files = await Promise.all(
        images.map(async (image: string) => {
          const file = resolve(folder, image)
          try {
            return { name: basename(file), content: (await readFile(file)).toString('base64') }
          } catch (error) {
            throw new BhError(
              `Post ${i + 1}: ${image} cannot be read`,
              {
                error: error instanceof Error ? error.message : String(error),
                hint: "A path is the posts file folder's unless absolute",
              },
              2,
            )
          }
        }),
      )
      return { ...(row as object), images: files }
    }),
  )
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

/**
 * Secrets, one per question: asked with the typing hidden at a terminal, or read from stdin one a
 * line when it is piped (`op read … | bh …`). Never taken as flags, which the shell's history keeps.
 */
export async function readSecrets(questions: string[]): Promise<string[]> {
  if (!process.stdin.isTTY) return (await stdin()).split(/\r?\n/).slice(0, questions.length)
  const answers = []
  for (const question of questions) answers.push(await hidden(question))
  return answers
}

function hidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    })
    const write = rl as unknown as { _writeToOutput: (s: string) => void }
    write._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stderr.write(s)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stderr.write('\n')
      resolve(answer.trim())
    })
  })
}
