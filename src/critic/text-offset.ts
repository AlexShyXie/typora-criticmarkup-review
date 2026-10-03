/**
 * Mapping a document-wide stream offset back onto a concrete text node.
 *
 * The editor's `#write` subtree is flattened into a "stream": every text
 * node in document order plus its starting offset. Write-backs work on
 * that stream (they match raw markdown text) but must finally produce a
 * DOM `Range`, so an offset has to be resolved to (node, innerOffset).
 *
 * Kept DOM-free and generic (only `textContent` is read) so the boundary
 * rules can be unit-tested with plain objects.
 */

/** Minimal shape needed from a text node (also satisfied by plain objects). */
export interface TextStreamNode {
  readonly textContent: string | null
}

export interface TextStreamPosition<T extends TextStreamNode> {
  node: T
  offset: number
}

/**
 * Resolve `offset` (stream space) to a node + inner offset.
 *
 * `preferEnd` decides what happens when `offset` lands EXACTLY on a node's
 * end boundary — a case that matters more than it looks:
 *
 * - `preferEnd: false` (default) hops to the NEXT node (offset 0), which is
 *   the right answer for a range START: the offset belongs to the token
 *   that begins there.
 * - `preferEnd: true` keeps the position on the node that ENDS there — the
 *   right answer for a range END (and for a parked caret). The next node may
 *   live in the NEXT block, and a selection stretched across that boundary
 *   silently eats the line break when it is replaced by an empty string
 *   (v0.3.1: stripping a token at end-of-line merged the following
 *   paragraph into it).
 *
 * Empty nodes are skipped by the `preferEnd` branch — parking on a zero
 * length node would be ambiguous.
 *
 * Out-of-range offsets fall back to the end of the last node (the caller
 * then produces a collapsed range at the stream end instead of failing).
 */
export function locateOffset<T extends TextStreamNode>(
  nodes: readonly T[],
  starts: readonly number[],
  offset: number,
  preferEnd = false,
): TextStreamPosition<T> | null {
  for (let i = 0; i < nodes.length; i++) {
    const len = nodes[i].textContent?.length ?? 0
    if (offset < starts[i] + len
      || (preferEnd && len > 0 && offset === starts[i] + len)) {
      return { node: nodes[i], offset: offset - starts[i] }
    }
  }
  const last = nodes[nodes.length - 1]
  if (last) {
    return { node: last, offset: last.textContent?.length ?? 0 }
  }
  return null
}
