import { escapeCommentBody } from './escape'
import { newThreadId, todayString } from './syntax'
import type { CriticTypeTag } from './types'
import { parseCommentMeta } from './parser'

/**
 * Thread markup building with lazy ids.
 *
 * A plain comment stays minimal (`{>>Hui|NOTE: body<<}`). The first time a
 * reply is added, both the first comment and the reply are rewritten with a
 * shared `rc-xxxxxx` id (and dates), upgrading to
 * `{>>rc-a1b2c3|Hui|2026-10-02|NOTE: body<<}`.
 *
 * All public helpers take the raw comment markup (as found in the document)
 * so the panel / write-back layer can call them without re-parsing the file.
 */

interface CommentFields {
  id: string | null
  author: string | null
  date: string | null
  typeTag: CriticTypeTag
  body: string
}

function buildCommentMarkup(f: CommentFields): string {
  const parts: string[] = []
  if (f.id) parts.push(f.id)
  if (f.author !== null && f.author !== '') parts.push(f.author)
  if (f.id && f.date) parts.push(f.date)
  const body = escapeCommentBody(f.body)
  return `{>>${parts.join('|')}${parts.length ? '|' : ''}${f.typeTag}: ${body}<<}`
}

/** `{>>Hui|NOTE: body<<}` — the everyday, no-id comment. */
export function buildPlainCommentMarkup(
  author: string, tag: CriticTypeTag, body: string,
): string {
  return buildCommentMarkup({ id: null, author, date: null, typeTag: tag, body })
}

/** `{==selection==}{>>Hui|NOTE: body<<}` — anchored comment. */
export function buildAnchoredCommentMarkup(
  selection: string, author: string, tag: CriticTypeTag, body: string,
): string {
  return `{==${selection}==}${buildPlainCommentMarkup(author, tag, body)}`
}

/**
 * Parse `originalRaw` (one or more adjacent `{>>...<<}` blocks, possibly
 * preceded by the anchored `{==...==}` highlight) into its parts.
 */
function splitThreadRaw(originalRaw: string): {
  highlight: string
  blocks: CommentFields[]
} {
  let rest = originalRaw
  let highlight = ''
  const hlMatch = rest.match(/^\{==([\s\S]*?)==\}/)
  if (hlMatch) {
    highlight = hlMatch[0]
    rest = rest.slice(hlMatch[0].length)
  }

  const blocks: CommentFields[] = []
  const blockRe = /\{>>\s*([\s\S]*?)\s*<<\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(rest))) {
    blocks.push(parseCommentMeta(m[1] ?? ''))
  }
  return { highlight, blocks }
}

/**
 * Upgrade `originalRaw` to a thread (assigning a fresh id when it does not
 * have one yet) and append a new reply.
 */
export function buildThreadMarkupWithReply(
  originalRaw: string,
  firstAuthor: string, firstTag: CriticTypeTag, firstBody: string,
  replyAuthor: string, replyBody: string,
): string {
  const { highlight, blocks } = splitThreadRaw(originalRaw)
  const hasId = blocks.some(b => b.id !== null)
  const id = hasId
    ? (blocks.find(b => b.id !== null)!.id as string)
    : newThreadId()

  const first = blocks[0] ?? {
    id, author: firstAuthor, date: todayString(), typeTag: firstTag, body: firstBody,
  }

  const parts: string[] = []
  if (highlight) parts.push(highlight)
  parts.push(buildCommentMarkup({
    id,
    author: first.author ?? firstAuthor,
    date: first.date ?? todayString(),
    typeTag: first.typeTag,
    body: first.body,
  }))

  for (const reply of blocks.slice(1)) {
    parts.push(buildCommentMarkup({
      id,
      author: reply.author ?? replyAuthor,
      date: reply.date ?? todayString(),
      typeTag: 'REPLY',
      body: reply.body,
    }))
  }

  parts.push(buildCommentMarkup({
    id,
    author: replyAuthor,
    date: todayString(),
    typeTag: 'REPLY',
    body: replyBody,
  }))

  return parts.join('')
}

/**
 * Replace only the first comment's body (and author/tag when given) inside
 * `originalRaw`, keeping every reply untouched.
 */
export function buildThreadWithNewBody(
  originalRaw: string,
  firstAuthor: string, firstTag: CriticTypeTag, preparedBody: string,
): string {
  const { highlight, blocks } = splitThreadRaw(originalRaw)
  const first = blocks[0] ?? {
    id: null, author: firstAuthor, date: null, typeTag: firstTag, body: '',
  }

  const parts: string[] = []
  if (highlight) parts.push(highlight)
  parts.push(buildCommentMarkup({
    id: first.id,
    author: firstAuthor,
    date: first.date,
    typeTag: firstTag,
    body: preparedBody,
  }))
  for (const reply of blocks.slice(1)) {
    parts.push(buildCommentMarkup({
      id: reply.id ?? first.id,
      author: reply.author ?? firstAuthor,
      date: reply.date ?? todayString(),
      typeTag: 'REPLY',
      body: reply.body,
    }))
  }
  return parts.join('')
}

/**
 * Replace ONLY the reply at `replyIndex` (0-based among replies) inside
 * `originalRaw`, keeping the highlight prefix, the first comment and every
 * other reply untouched. Returns `originalRaw` unchanged when the index is
 * out of range (no replies to edit).
 */
export function buildThreadWithEditedReply(
  originalRaw: string,
  replyIndex: number,
  fallbackAuthor: string,
  body: string,
): string {
  const { highlight, blocks } = splitThreadRaw(originalRaw)
  const targetIndex = 1 + replyIndex // blocks[0] is the first comment
  if (replyIndex < 0 || targetIndex >= blocks.length) return originalRaw
  const first = blocks[0]

  const parts: string[] = []
  if (highlight) parts.push(highlight)
  blocks.forEach((block, i) => {
    if (i !== targetIndex) {
      parts.push(buildCommentMarkup(block))
      return
    }
    parts.push(buildCommentMarkup({
      id: block.id ?? first?.id ?? null,
      author: block.author ?? fallbackAuthor,
      date: block.date ?? todayString(),
      typeTag: 'REPLY',
      body,
    }))
  })
  return parts.join('')
}

/** Markup that removes the whole thread (anchored highlight included). */
export function buildThreadRemoval(): string {
  return ''
}
