/**
 * Where the caret should land when the user CLICKS a comment chip.
 *
 * v0.4.4: a comment chip is `font-size: 0` + `user-select: none` (see
 * `style.scss`), so Chromium cannot put a mouse-driven caret INSIDE it —
 * the click lands on the unit boundary instead and the renderer never
 * reveals the source (the user had to press Arrow-Right once). The fix is
 * to park the caret explicitly, and this module decides WHERE.
 *
 * Kept DOM-free and generic (pure string in, number out) so the rule can be
 * unit-tested with plain strings — same contract as `text-offset.ts`.
 */

/**
 * `|NOTE:` / `|REPLY:` … — the type tag that separates the comment's
 * metadata from its body. Only used to locate the body start, never to
 * parse the comment.
 */
const TYPE_TAG_CARET_RE = /(?:NOTE|ASK|EDIT|PRAISE|REPLY)\s*:/

/** At most `id|author|date|` precede the body; any later `|` is body text. */
const MAX_META_BARS = 3

/**
 * Offset (relative to `raw`) of the comment's BODY start — the landing spot
 * for a caret parked by a chip click.
 *
 * Rules, in order:
 *  1. Typed comment (`{>>rc-x|Hui|2026-10-03|NOTE: body<<}`): right after
 *     the `|TAG:` prefix, then past the separating space.
 *  2. Untyped comment with metadata (`{>>rc-x|Hui|2026-10-03|body<<}`):
 *     right after the last metadata `|` — at most `MAX_META_BARS`, so a `|`
 *     inside the body is never mistaken for the separator.
 *  3. Plain comment (`{>>body<<}`): right after the opening `{>>`.
 *
 * The result is always clamped inside `[open, close)`, i.e. it can never
 * land on the `<<}` delimiter.
 */
export function commentCaretOffset(raw: string): number {
  if (!raw) return 0
  const len = raw.length
  const open = raw.startsWith('{>>') ? 3 : 0
  let close = raw.lastIndexOf('<<')
  if (close < open) close = len

  const skipSpace = (from: number): number => {
    let i = from
    while (i < close && raw[i] === ' ') i++
    return i
  }

  // (1) typed: `…|NOTE: body<<}` → just before `body`.
  const tag = TYPE_TAG_CARET_RE.exec(raw.slice(open, close))
  if (tag) return skipSpace(open + tag.index + tag[0].length)

  // (2) untyped: walk the metadata bars, never past MAX_META_BARS of them.
  const bars: number[] = []
  for (let i = open; i < close; i++) {
    if (raw[i] === '|') bars.push(i)
  }
  if (bars.length === 0) return skipSpace(open) // (3) plain comment
  return skipSpace(bars[Math.min(bars.length, MAX_META_BARS) - 1] + 1)
}
