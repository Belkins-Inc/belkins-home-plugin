import { BhError } from './client.ts'
import { readText } from './input.ts'

/** CSV rows as lists of cells: commas or semicolons, quoted cells with "" for a quote, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split('\n', 1)[0] ?? ''
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows.filter((r) => r.some((c) => c.trim()))
}

export type DncRow = { kind: 'email' | 'domain'; value: string; reason?: string; note?: string }

const HEADERS = ['email', 'domain', 'value', 'kind', 'reason', 'note']

/**
 * The entries in a dnc CSV: a column `email` or `domain` (or both), or `value` with an optional
 * `kind` — a value with `@` is an address, else a domain; `reason` and `note` columns are kept.
 * A file with no header row is one value per line.
 */
export async function readDncCsv(path: string): Promise<DncRow[]> {
  const rows = parseCsv((await readText(path)).replace(/^\uFEFF/, ''))
  const [first, ...rest] = rows
  if (!first) return []
  const header = first.map((h) => h.trim().toLowerCase())
  const at = (name: string) => header.indexOf(name)
  const inferred = (value: string): DncRow['kind'] => (value.includes('@') ? 'email' : 'domain')
  if (!header.some((h) => HEADERS.includes(h))) {
    if (first.length > 1)
      throw new BhError(
        `${path}: no column named email, domain or value`,
        { hint: 'a header row: email | domain | value[,kind][,reason][,note]' },
        2,
      )
    return rows.map((r) => {
      const v = (r[0] ?? '').trim()
      return { kind: inferred(v), value: v }
    })
  }
  const [email, domain, value, kind, reason, note] = [
    at('email'),
    at('domain'),
    at('value'),
    at('kind'),
    at('reason'),
    at('note'),
  ]
  if (email < 0 && domain < 0 && value < 0)
    throw new BhError(
      `${path}: no column named email, domain or value`,
      { hint: 'a header row: email | domain | value[,kind][,reason][,note]' },
      2,
    )
  return rest.flatMap((r) => {
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
    const extra = {
      ...(cell(reason) ? { reason: cell(reason) } : {}),
      ...(cell(note) ? { note: cell(note) } : {}),
    }
    const out: DncRow[] = []
    if (cell(email)) out.push({ kind: 'email', value: cell(email), ...extra })
    if (cell(domain)) out.push({ kind: 'domain', value: cell(domain), ...extra })
    if (cell(value)) {
      const k = cell(kind).toLowerCase()
      out.push({
        kind: k === 'email' || k === 'domain' ? k : inferred(cell(value)),
        value: cell(value),
        ...extra,
      })
    }
    return out
  })
}
