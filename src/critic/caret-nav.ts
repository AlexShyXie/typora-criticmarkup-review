import { SYNTAX } from './syntax'
import { commentNavKey } from './thread'
import type { CommentToken, CriticToken } from './types'

/**
 * v0.4.8: translate a settled reveal unit into its SOURCE-file spelling —
 * the key the panel's file-space entries are matched by. Comments arrive
 * as their nav key (anchor stripped); consumed shapes are re-synthesized
 * (`{x}` → `{==x==}`, `{a~>b}` → `{~~a~>b~~}`).
 *
 * Lives in the pure-logic layer (no DOM / framework imports) so it is
 * unit-testable in the node environment — the renderer passes its
 * RevealUnit fields through.
 */

export type CaretUnitShape = {
  kind: 'token' | 'consumed-anchor' | 'consumed-subst'
  key: string
  token?: CriticToken | null
}

export function caretUnitNavKey(unit: CaretUnitShape): string | null {
  if (unit.kind === 'token' && unit.token) {
    const t = unit.token
    if (t.type === 'comment') return commentNavKey(t as CommentToken)
    // addition / deletion / substitution / highlight — raw IS the spelling.
    return t.raw
  }
  if (unit.kind === 'consumed-anchor') {
    return SYNTAX.HIGHLIGHT.open + unit.key.slice(1, -1) + SYNTAX.HIGHLIGHT.close
  }
  if (unit.kind === 'consumed-subst') {
    return SYNTAX.SUBSTITUTION.open + unit.key.slice(1, -1) + SYNTAX.SUBSTITUTION.close
  }
  return null
}
