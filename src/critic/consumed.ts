import { SYNTAX } from './syntax'

/**
 * Detection of Typora-consumed CriticMarkup shapes.
 *
 * Typora's native inline parser eats `==text==` (its highlight syntax) and
 * `~~text~~` (its strikethrough syntax) — both occur inside CriticMarkup
 * wrappers. After a document (re)load the DOM text therefore holds the
 * CONSUMED forms `{text}` / `{old~>new}` instead of the raw
 * `{==text==}` / `{~~old~>new~~}`: the `==` / `~~` characters no longer
 * exist in the DOM and the source-form regexes cannot see the tokens.
 *
 * This module holds the DOM-free part of the detection (text scanning).
 * The renderer verifies each candidate against the actual `<mark>` /
 * `<del>` element Typora produced before treating it as a token, which
 * keeps literal `{a~>b}` prose from producing phantom tokens.
 */

/** A `{old~>new}` shape in block text — candidate consumed substitution. */
export interface ConsumedSubstitutionRange {
  /** Offset of the opening `{`. */
  from: number
  /** Offset past the closing `}` (exclusive). */
  to: number
  oldText: string
  newText: string
  /** `{old~>new}` — the DOM-space raw used for write-back matching. */
  raw: string
}

/**
 * Scan block text for consumed-substitution shapes, skipping regions that
 * are already covered by parsed source-form tokens (the raw `{~~a~>b~~}`
 * spelling also contains a `{...~>...}` shape and must not produce a
 * phantom consumed token on top of it).
 */
export function findConsumedSubstitutionRanges(
  text: string,
  skipRanges: ReadonlyArray<{ from: number; to: number }> = [],
): ConsumedSubstitutionRange[] {
  const out: ConsumedSubstitutionRange[] = []
  const re = /\{([^{}\n]*~>[^{}\n]*)\}/g
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const from = m.index
    const to = from + m[0].length
    if (skipRanges.some(r => from < r.to && r.from < to)) continue
    const content = m[1] ?? ''
    const join = content.indexOf(SYNTAX.SUBSTITUTION_JOIN)
    if (join < 0) continue
    out.push({
      from,
      to,
      oldText: content.slice(0, join),
      newText: content.slice(join + SYNTAX.SUBSTITUTION_JOIN.length),
      raw: m[0],
    })
  }
  return out
}
