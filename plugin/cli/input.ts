import { readFile } from 'node:fs/promises'
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
