/**
 * CriticMarkup token data model.
 *
 * Offsets (`from` / `to`) are character offsets into the full markdown source
 * string that was parsed, matching the CriticMarkup spec ranges.
 *
 * Parser core is ported from obsidian-review-critics (MIT, (c) 2026 Daniel
 * Rohrbach) and extended with typed comments + lazy thread ids.
 */

export type CriticTokenType =
  | 'addition'
  | 'deletion'
  | 'substitution'
  | 'highlight'
  | 'comment'

/** Comment type tags shown in the UI. `REPLY` is reserved for thread replies. */
export type CriticTypeTag = 'ASK' | 'EDIT' | 'PRAISE' | 'NOTE' | 'REPLY'

export interface RangeOffset {
  from: number
  to: number
}

export interface TokenBase extends RangeOffset {
  type: CriticTokenType
  /** Raw markup text incl. delimiters, e.g. `{++foo++}` */
  raw: string
  /** Index of the nearest preceding heading line, for panel grouping. */
  section: string
}

export interface AdditionToken extends TokenBase {
  type: 'addition'
  text: string
}

export interface DeletionToken extends TokenBase {
  type: 'deletion'
  text: string
}

export interface SubstitutionToken extends TokenBase {
  type: 'substitution'
  oldText: string
  newText: string
}

export interface HighlightToken extends TokenBase {
  type: 'highlight'
  text: string
}

export interface CommentToken extends TokenBase {
  type: 'comment'
  /** Thread id (`rc-xxxxxx`) once assigned; null for plain comments. */
  id: string | null
  author: string | null
  date: string | null
  typeTag: CriticTypeTag
  /** Unescaped comment body (real newlines). */
  body: string
  /**
   * When the comment directly follows a `{==...==}` highlight, the pair is
   * an anchored comment and the highlight range is recorded here.
   */
  anchored: {
    highlightFrom: number
    highlightTo: number
    highlightRaw: string
    /** Highlighted text inside `{==...==}`. */
    text: string
  } | null
}

export type CriticToken =
  | AdditionToken
  | DeletionToken
  | SubstitutionToken
  | HighlightToken
  | CommentToken

/**
 * v0.4.6: `HighlightToken` joins the panel's change list. A highlight is not
 * an edit, but the panel is the only place that lists "what is marked in
 * this note", and `{==..==}` had no card at all before.
 */
export type TrackedChangeToken =
  | AdditionToken
  | DeletionToken
  | SubstitutionToken
  | HighlightToken

/** A resolved comment thread: first comment + its replies. */
export interface CommentThread {
  /** Offset of the first comment token in the source. */
  from: number
  /** Offset past the last reply token (or first token when no replies). */
  to: number
  /** Full raw markup of all comment tokens incl. replies. */
  raw: string
  id: string | null
  first: CommentToken
  replies: CommentToken[]
  /** Anchored highlight, when this thread is attached to `{==...==}`. */
  anchor: CommentToken['anchored']
  section: string
  /** 1-based source line of the first comment token. */
  line: number
}

/** Entry model for the panel's "changes" section. */
export interface ChangePanelEntry {
  id: string
  token: TrackedChangeToken
  section: string
}

/** Entry model for the panel's "comments" section. */
export interface CommentPanelEntry {
  id: string
  thread: CommentThread
  section: string
}
