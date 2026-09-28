import type { BhConfig } from './config.ts'

export class BhError extends Error {
  readonly payload: unknown
  readonly exitCode: number
  constructor(message: string, payload: unknown, exitCode = 1) {
    super(message)
    this.payload = payload
    this.exitCode = exitCode
  }
}

/** One request to the engine; errors come back verbatim, as the API wrote them. */
export async function call(
  config: BhConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const api = process.env.BH_API ?? config.api
  if (!api) throw new BhError('No API set', { hint: 'bh login --api <url> --token <token>' }, 2)
  const token = process.env.BH_TOKEN ?? config.token
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  // Joined as text, not new URL(path, api): an absolute path would drop a prefix such as the web
  // app's /api, and the request would land on its HTML instead of the engine.
  const response = await fetch(`${api.replace(/\/+$/, '')}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const payload = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) throw new BhError(`${method} ${path} → ${response.status}`, payload)
  return payload
}
