/**
 * `bh sql`'s @project: the current project's id, put in where @project stands as a token of its
 * own — never inside a quoted string, a quoted name or a comment, and never as part of a longer
 * word, so an address such as `ann@projectsforce.com` is read as written (belkins-home-plugin#132).
 */
export function hasProjectToken(query: string): boolean {
  return withProjectId(query, '') !== query
}

const TOKEN = '@project'

/** The query with each @project token replaced by the id as a string literal. */
export function withProjectId(query: string, id: string): string {
  let out = ''
  let i = 0
  while (i < query.length) {
    const skip = quotedEnd(query, i)
    if (skip > i) {
      out += query.slice(i, skip)
      i = skip
      continue
    }
    if (
      query.startsWith(TOKEN, i) &&
      !/[\w@.]/.test(query[i - 1] ?? '') &&
      !/\w/.test(query[i + TOKEN.length] ?? '')
    ) {
      out += `'${id}'`
      i += TOKEN.length
      continue
    }
    out += query[i]
    i++
  }
  return out
}

/** Where a quoted string, quoted name, dollar-quoted body or comment starting at i ends; i if none starts there. */
function quotedEnd(q: string, i: number): number {
  const c = q[i]
  if (c === "'" || c === '"') {
    let j = i + 1
    while (j < q.length) {
      if (q[j] !== c) j++
      else if (q[j + 1] === c) j += 2 // a doubled quote is one quote inside
      else return j + 1
    }
    return q.length
  }
  if (c === '-' && q[i + 1] === '-') {
    const end = q.indexOf('\n', i)
    return end === -1 ? q.length : end
  }
  if (c === '/' && q[i + 1] === '*') {
    const end = q.indexOf('*/', i + 2)
    return end === -1 ? q.length : end + 2
  }
  if (c === '$' && !/\w/.test(q[i - 1] ?? '')) {
    const tag = /^\$[A-Za-z_]*\$/.exec(q.slice(i))
    if (tag) {
      const end = q.indexOf(tag[0], i + tag[0].length)
      return end === -1 ? q.length : end + tag[0].length
    }
  }
  return i
}
