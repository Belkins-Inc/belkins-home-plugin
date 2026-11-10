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

export type DncRow = {
  kind: 'email' | 'domain' | 'phone' | 'linkedin'
  value: string
  reason?: string
  note?: string
}

const HEADERS = ['email', 'domain', 'phone', 'linkedin', 'value', 'kind', 'reason', 'note']
const KINDS = new Set(['email', 'domain', 'phone', 'linkedin'])

/**
 * The entries in a dnc CSV: a column `email`, `domain`, `phone` or `linkedin` (or several), or
 * `value` with an optional `kind` — a linkedin.com URL is a profile, a value with `@` an address,
 * one of digits and punctuation a phone number, else a domain; `reason` and `note` columns are kept. A file with no header row is one value per
 * line.
 */
export async function readDncCsv(path: string): Promise<DncRow[]> {
  const rows = parseCsv((await readText(path)).replace(/^\uFEFF/, ''))
  const [first, ...rest] = rows
  if (!first) return []
  const header = first.map((h) => h.trim().toLowerCase())
  const at = (name: string) => header.indexOf(name)
  const inferred = (value: string): DncRow['kind'] =>
    /linkedin\.com\//i.test(value)
      ? 'linkedin'
      : value.includes('@')
        ? 'email'
        : /^\+?[\d\s().\-/]{7,}$/.test(value)
          ? 'phone'
          : 'domain'
  if (!header.some((h) => HEADERS.includes(h))) {
    if (first.length > 1)
      throw new BhError(
        `${path}: no column named email, domain, phone, linkedin or value`,
        { hint: 'a header row: email | domain | phone | linkedin | value[,kind][,reason][,note]' },
        2,
      )
    return rows.map((r) => {
      const v = (r[0] ?? '').trim()
      return { kind: inferred(v), value: v }
    })
  }
  const [email, domain, phone, linkedin, value, kind, reason, note] = [
    at('email'),
    at('domain'),
    at('phone'),
    at('linkedin'),
    at('value'),
    at('kind'),
    at('reason'),
    at('note'),
  ]
  if (email < 0 && domain < 0 && phone < 0 && linkedin < 0 && value < 0)
    throw new BhError(
      `${path}: no column named email, domain, phone, linkedin or value`,
      { hint: 'a header row: email | domain | phone | linkedin | value[,kind][,reason][,note]' },
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
    if (cell(phone)) out.push({ kind: 'phone', value: cell(phone), ...extra })
    if (cell(linkedin)) out.push({ kind: 'linkedin', value: cell(linkedin), ...extra })
    if (cell(value)) {
      const k = cell(kind).toLowerCase()
      out.push({
        kind: KINDS.has(k) ? (k as DncRow['kind']) : inferred(cell(value)),
        value: cell(value),
        ...extra,
      })
    }
    return out
  })
}
