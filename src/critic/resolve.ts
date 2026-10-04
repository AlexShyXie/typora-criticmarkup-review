import type {
  AdditionToken,
  CommentToken,
  CriticToken,
  DeletionToken,
  HighlightToken,
  SubstitutionToken,
} from './types'

/**
 * Text transforms for resolving review markup.
 * All functions are pure: (token, source) -> replacement string.
 */

/** Accept a change: keep the new state of the text. */
export function acceptToken(token: CriticToken): string {
  switch (token.type) {
    case 'addition':
      return (token as AdditionToken).text
    case 'deletion':
      return ''
    case 'substitution':
      return (token as SubstitutionToken).newText
    case 'highlight':
    case 'comment':
      // Accept on highlight/comment = resolve: drop markup, keep text (or
      // drop the whole comment when standalone).
      if (token.type === 'comment') {
        const comment = token as CommentToken
        return comment.anchored
          ? comment.anchored.text
          : ''
      }
      return (token as HighlightToken).text
  }
}

/**
 * Reject a change: restore the old state of the text.
 *
 * v0.4.6: a standalone `{==..==}` now follows CriticMarkup's standard
 * semantics — rejecting DROPS the highlighted text (`''`), while accepting
 * keeps it and only removes the markup. Before this, accept and reject were
 * the same operation on a highlight, which made the panel's two buttons a
 * no-op pair. Note the knock-on: `rejectAll` now deletes every unanchored
 * highlight in the document.
 *
 * A comment anchored to a highlight is the exception: reject keeps the
 * anchored text, otherwise the comment would lose the words it refers to.
 */
export function rejectToken(token: CriticToken): string {
  switch (token.type) {
    case 'addition':
      return ''
    case 'deletion':
      return (token as DeletionToken).text
    case 'substitution':
      return (token as SubstitutionToken).oldText
    case 'highlight':
      return ''
    case 'comment': {
      const comment = token as CommentToken
      return comment.anchored
        ? comment.anchored.text
        : ''
    }
  }
}

/**
 * Apply replacements for a list of tokens against the source text.
 * Tokens must be non-overlapping; applied from last to first so earlier
 * offsets stay valid.
 */
export function applyTokenReplacements(
  source: string,
  replacements: { token: CriticToken; text: string }[],
): string {
  const sorted = [...replacements].sort((a, b) => b.token.from - a.token.from)
  let out = source
  for (const { token, text } of sorted) {
    out = out.slice(0, token.from) + text + out.slice(token.to)
  }
  return out
}

/** Accept every change in the document, drop every comment. */
export function acceptAll(source: string, tokens: CriticToken[]): string {
  return applyTokenReplacements(
    source,
    tokens.map(token => ({ token, text: acceptToken(token) })),
  )
}

/** Reject every change in the document, drop every comment. */
export function rejectAll(source: string, tokens: CriticToken[]): string {
  return applyTokenReplacements(
    source,
    tokens.map(token => ({ token, text: rejectToken(token) })),
  )
}

/**
 * The "accepted view" projection of the source text: what the document looks
 * like with every change accepted, while leaving the actual file untouched.
 */
export function projectAcceptedText(source: string, tokens: CriticToken[]): string {
  return acceptAll(source, tokens)
}
