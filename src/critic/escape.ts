/**
 * Escaping for inline comment metadata.
 *
 * The comment body lives inside `{>>...<<}` on a single line and uses `|` as
 * the metadata separator, so pipes and newlines in the body must be escaped:
 *
 *   `\`  -> `\\`
 *   `|`  -> `\|`
 *   LF   -> `\n`  (literal two chars)
 */
export function escapeCommentBody(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\\n')
}

export function unescapeCommentText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      if (next === 'n') { out += '\n'; i++; continue }
      if (next === '|' || next === '\\') { out += next; i++; continue }
    }
    out += ch
  }
  return out
}
