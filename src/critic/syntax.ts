import type { CriticTypeTag } from './types'

/**
 * CriticMarkup spec delimiters.
 * @see https://criticmarkup.com/specification.html
 */
export const SYNTAX = {
  ADDITION: { open: '{++', close: '++}' },
  DELETION: { open: '{--', close: '--}' },
  SUBSTITUTION: { open: '{~~', close: '~~}' },
  SUBSTITUTION_JOIN: '~>',
  HIGHLIGHT: { open: '{==', close: '==}' },
  COMMENT: { open: '{>>', close: '<<}' },
} as const

/**
 * Inline metadata format inside `{>> ... <<}`:
 *
 * - legacy (obsidian-review-critics): `{>>[author=Hui] body<<}`
 * - plain:        `{>>Hui|NOTE: body<<}`
 * - with thread:  `{>>rc-a1b2c3|Hui|2026-10-02|NOTE: body<<}`
 *   (thread id appears once a reply is added; replies share the id)
 *
 * Segments are separated by `|`; a `|` inside body is escaped as `\|`.
 */
export const COMMENT_ID_RE = /^rc-[0-9a-z]{6}$/
export const COMMENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const LEGACY_AUTHOR_RE = /^\[author=([^\]]*)\]\s?/
/** Splits on unescaped pipes. */
export const SEGMENT_SPLIT_RE = /(?<!\\)\|/

export const TYPE_TAGS: readonly CriticTypeTag[] = [
  'ASK', 'EDIT', 'PRAISE', 'NOTE', 'REPLY',
]

/** Type tags selectable in the UI (REPLY is internal, for replies only). */
export const SELECTABLE_TYPE_TAGS: readonly CriticTypeTag[] = [
  'ASK', 'EDIT', 'PRAISE', 'NOTE',
]

export function typeTagPrefixRe(tag: CriticTypeTag): RegExp {
  return new RegExp(`^${tag}:\\s?`)
}

export const ANY_TYPE_TAG_RE = /^(ASK|EDIT|PRAISE|NOTE|REPLY):\s?/

export function newThreadId(): string {
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += Math.floor(Math.random() * 36).toString(36)
  }
  return `rc-${suffix}`
}

export function todayString(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}
