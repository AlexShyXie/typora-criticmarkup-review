import {
  ANY_TYPE_TAG_RE,
  COMMENT_DATE_RE,
  COMMENT_ID_RE,
  LEGACY_AUTHOR_RE,
  SEGMENT_SPLIT_RE,
  SYNTAX,
  TYPE_TAGS,
  typeTagPrefixRe,
} from './syntax'
import { unescapeCommentText } from './escape'
import type {
  AdditionToken,
  ChangePanelEntry,
  CommentPanelEntry,
  CommentThread,
  CommentToken,
  CriticToken,
  CriticTypeTag,
  DeletionToken,
  HighlightToken,
  SubstitutionToken,
  TrackedChangeToken,
} from './types'

/**
 * CriticMarkup parser.
 *
 * Structural flow (fence skipping -> candidate collection -> overlap
 * normalization -> anchored-comment merge) is ported from
 * obsidian-review-critics (MIT, (c) 2026 Daniel Rohrbach); the comment
 * metadata format and thread aggregation are Typora-plugin specific.
 */
export class CriticParser {

  // ---------------------------------------------------------------- tokens

  /**
   * Parse CriticMarkup tokens.
   *
   * `mergeAnchored: false` skips the anchored-pair merge: `{==text==}` and
   * each adjacent `{>>...<<}` stay SEPARATE tokens with their own raw. The
   * renderer and the cursor paths use this mode so the anchor and every
   * comment block reveal / strip independently (v0.3.0); the panel and the
   * accept/reject semantics keep the merged default (one token covering the
   * whole `{==..==}{>>..<<}` region).
   */
  parseTokens(content: string, opts?: { mergeAnchored?: boolean }): CriticToken[] {
    const candidates = this.collectCandidateTokens(content)
    const normalized = this.normalizeOverlaps(candidates)

    if (opts?.mergeAnchored === false) {
      return [...normalized].sort((a, b) => a.from - b.from || a.to - b.to)
    }

    const anchored = this.buildAnchoredPairs(content, normalized)

    const output: CriticToken[] = []
    normalized.forEach((token, index) => {
      if (anchored.consumedIndexes.has(index)) return
      output.push(token)
    })

    for (const pair of anchored.pairs) {
      const highlight = pair.highlight as HighlightToken
      const comment = pair.comment as CommentToken
      comment.anchored = {
        highlightFrom: highlight.from,
        highlightTo: highlight.to,
        highlightRaw: highlight.raw,
        text: highlight.text,
      }
      // Extend the comment token over the anchored highlight so that
      // accept/reject replaces the whole `{==..==}{>>..<<}` region.
      comment.from = highlight.from
      comment.raw = highlight.raw + comment.raw
      output.push(comment)
    }

    output.sort((a, b) => a.from - b.from || a.to - b.to)
    return output
  }

  // ------------------------------------------------------------- threads

  /** Aggregate comment tokens into threads (first comment + same-id replies). */
  buildCommentThreads(content: string): CommentThread[] {
    const tokens = this.parseTokens(content)
      .filter((t): t is CommentToken => t.type === 'comment')

    const threads: CommentThread[] = []

    for (const token of tokens) {
      const previous = threads[threads.length - 1]
      const canAppend =
        previous !== undefined &&
        token.id !== null &&
        previous.id === token.id &&
        previous.to <= token.from &&
        // Same visual line only (spaces/tabs): keeps a thread inside one
        // block so DOM write-back can locate it reliably.
        /^[ \t]*$/.test(content.slice(previous.to, token.from))

      if (canAppend) {
        previous.replies.push(token)
        previous.to = token.to
        previous.raw = content.slice(previous.from, token.to)
        continue
      }

      threads.push({
        from: token.from,
        to: token.to,
        raw: token.raw,
        id: token.id,
        first: token,
        replies: [],
        anchor: token.anchored ?? null,
        section: token.section,
        line: 0,
      })
    }

    return threads
  }

  // -------------------------------------------------------------- panel

  buildChangeEntries(content: string): ChangePanelEntry[] {
    const tokens = this.parseTokens(content)
    return tokens
      // v0.4.6: `highlight` in — a standalone `{==..==}` was invisible in
      // the panel. Ones anchored to a `{>>..<<}` are already consumed by
      // `buildAnchoredPairs` (they show up as the comment's quote row), so
      // they never reach this list and cannot appear twice.
      .filter((t): t is TrackedChangeToken =>
        t.type === 'addition' || t.type === 'deletion'
        || t.type === 'substitution' || t.type === 'highlight')
      .map((token, index) => ({
        id: `${token.type}:${token.from}:${token.to}:${index}`,
        token,
        section: token.section,
      }))
  }

  buildCommentEntries(content: string): CommentPanelEntry[] {
    const threads = this.buildCommentThreads(content)
    const lineStarts = this.getLineStarts(content)
    // Stable ids: rc-threads keep their id across offset shifts; plain
    // comments fall back to a content hash. Position-based ids broke the
    // panel's editing/replying state on every document change before them.
    const seen = new Map<string, number>()
    return threads.map((thread) => {
      const base = thread.id
        ? `thread:${thread.id}`
        : `comment:${hashStr(thread.first.raw + (thread.anchor?.highlightRaw ?? ''))}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return {
        id: n === 0 ? base : `${base}#${n}`,
        thread: {
          ...thread,
          line: this.getLineNumber(lineStarts, thread.from),
        },
        section: thread.section,
      }
    })
  }

  /** Line number (1-based) for an offset. */
  getLineNumber(lineStarts: number[], offset: number): number {
    let low = 0
    let high = lineStarts.length - 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (lineStarts[mid] <= offset) low = mid + 1
      else high = mid - 1
    }
    return Math.max(1, high + 1)
  }

  getLineStarts(content: string): number[] {
    const starts = [0]
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') starts.push(i + 1)
    }
    return starts
  }

  // ----------------------------------------------------------- internals

  private collectCandidateTokens(content: string): CriticToken[] {
    const candidates: CriticToken[] = []
    const segments = this.getNonCodeSegments(content)
    const headings = this.collectHeadings(content)

    for (const segment of segments) {
      const sectionOf = (offset: number) =>
        this.getNearestHeading(headings, offset)

      this.collectMatches(segment, /\{\+\+([\s\S]*?)\+\+\}/g, (m, offset) => {
        candidates.push({
          type: 'addition', from: offset, to: offset + m[0].length,
          raw: m[0], text: m[1] ?? '', section: sectionOf(offset),
        } as AdditionToken)
      })

      this.collectMatches(segment, /\{--([\s\S]+?)--\}/g, (m, offset) => {
        candidates.push({
          type: 'deletion', from: offset, to: offset + m[0].length,
          raw: m[0], text: m[1] ?? '', section: sectionOf(offset),
        } as DeletionToken)
      })

      this.collectMatches(segment, /\{~~([\s\S]+?)~>([\s\S]*?)~~\}/g, (m, offset) => {
        candidates.push({
          type: 'substitution', from: offset, to: offset + m[0].length,
          raw: m[0], oldText: m[1] ?? '', newText: m[2] ?? '', section: sectionOf(offset),
        } as SubstitutionToken)
      })

      this.collectMatches(segment, /\{==([\s\S]+?)==\}/g, (m, offset) => {
        candidates.push({
          type: 'highlight', from: offset, to: offset + m[0].length,
          raw: m[0], text: m[1] ?? '', section: sectionOf(offset),
        } as HighlightToken)
      })

      // Comment: keep legacy `[author=X]` and new pipe format; may span lines
      // in legacy documents.
      this.collectMatches(
        segment,
        /\{>>\s*([\s\S]*?)\s*<<\}/g,
        (m, offset) => {
          const meta = parseCommentMeta(m[1] ?? '')
          candidates.push({
            type: 'comment', from: offset, to: offset + m[0].length,
            raw: m[0], section: sectionOf(offset),
            id: meta.id, author: meta.author, date: meta.date,
            typeTag: meta.typeTag, body: meta.body,
            anchored: null,
          } as CommentToken)
        },
      )
    }

    return candidates
  }

  private normalizeOverlaps(candidates: CriticToken[]): CriticToken[] {
    const sorted = [...candidates].sort((a, b) => a.from - b.from || a.to - b.to)
    const normalized: CriticToken[] = []
    for (const token of sorted) {
      const previous = normalized[normalized.length - 1]
      if (previous && token.from < previous.to) continue
      normalized.push(token)
    }
    return normalized
  }

  private buildAnchoredPairs(
    content: string,
    normalized: CriticToken[],
  ): { consumedIndexes: Set<number>; pairs: { highlight: CriticToken; comment: CriticToken }[] } {
    const consumedIndexes = new Set<number>()
    const pairs: { highlight: CriticToken; comment: CriticToken }[] = []

    for (let i = 0; i < normalized.length - 1; i++) {
      const current = normalized[i]
      const next = normalized[i + 1]
      if (current.type !== 'highlight' || next.type !== 'comment') continue

      const between = content.slice(current.to, next.from)
      if (!/^\s*$/.test(between)) continue

      consumedIndexes.add(i)
      consumedIndexes.add(i + 1)
      pairs.push({ highlight: current, comment: next })
    }

    return { consumedIndexes, pairs }
  }

  private getNonCodeSegments(content: string): { start: number; text: string }[] {
    const lines = content.split('\n')
    const segments: { start: number; text: string }[] = []
    const chunk: string[] = []

    let inFence = false
    let fenceMarker = ''
    let offset = 0
    let chunkStart = 0

    const flush = (nextOffset: number) => {
      if (chunk.length === 0) {
        chunkStart = nextOffset
        return
      }
      segments.push({ start: chunkStart, text: chunk.join('\n') })
      chunk.length = 0
      chunkStart = nextOffset
    }

    lines.forEach((line, index) => {
      const isLast = index === lines.length - 1
      const lineWithBreak = isLast ? line : `${line}\n`
      const fenceMatch = line.match(/^\s*(```+|~~~+)/)

      if (fenceMatch) {
        const marker = fenceMatch[1][0]
        if (!inFence) {
          flush(offset)
          inFence = true
          fenceMarker = marker
        } else if (fenceMarker === marker) {
          inFence = false
          chunkStart = offset + lineWithBreak.length
        }
        offset += lineWithBreak.length
        return
      }

      if (!inFence) chunk.push(line)
      offset += lineWithBreak.length
    })

    flush(offset)
    return segments
  }

  private collectMatches(
    segment: { start: number; text: string },
    regex: RegExp,
    onMatch: (match: RegExpExecArray, offset: number) => void,
  ) {
    regex.lastIndex = 0
    let match = regex.exec(segment.text)
    while (match) {
      onMatch(match, segment.start + match.index)
      match = regex.exec(segment.text)
    }
  }

  private collectHeadings(content: string): { from: number; text: string }[] {
    const headings: { from: number; text: string }[] = []
    const lines = content.split('\n')
    let offset = 0
    lines.forEach((line, index) => {
      const m = line.match(/^(#{1,6})\s+(.+)$/)
      if (m) headings.push({ from: offset, text: m[2].trim() })
      offset += line.length
      if (index < lines.length - 1) offset += 1
    })
    return headings
  }

  private getNearestHeading(headings: { from: number; text: string }[], offset: number): string {
    let current = 'Document root'
    for (const heading of headings) {
      if (heading.from > offset) break
      current = heading.text
    }
    return current
  }
}

// ------------------------------------------------------------ meta parse

export interface CommentMeta {
  id: string | null
  author: string | null
  date: string | null
  typeTag: CriticTypeTag
  body: string
}

/**
 * Parse the inline metadata of a comment body.
 *
 * Accepted shapes (whitespace-trimmed):
 *   `[author=Hui] body`                      (legacy obsidian-review-critics)
 *   `body`                                   (plain)
 *   `TYPE: body`                             (plain typed)
 *   `Hui|body`                               (author + body)
 *   `Hui|TYPE: body`                         (author + typed body)
 *   `rc-a1b2c3|Hui|2026-10-02|TYPE: body`    (thread upgrade)
 */
export function parseCommentMeta(raw: string): CommentMeta {
  let text = raw.trim()

  // legacy author prefix
  const legacy = text.match(LEGACY_AUTHOR_RE)
  if (legacy) {
    return {
      id: null,
      author: legacy[1] || null,
      date: null,
      typeTag: 'NOTE',
      body: unescapeCommentText(text.slice(legacy[0].length)),
    }
  }

  const segs = text.split(SEGMENT_SPLIT_RE).map(s => s.trim())
  let id: string | null = null
  let date: string | null = null
  let author: string | null = null
  let i = 0

  if (segs.length > 0 && COMMENT_ID_RE.test(segs[0])) {
    id = segs[0]
    i = 1
  }

  const rest = segs.slice(i)
  if (rest.length >= 3) {
    author = rest[0]
    if (COMMENT_DATE_RE.test(rest[1])) {
      date = rest[1]
      text = rest.slice(2).join('|')
    } else {
      text = rest.slice(1).join('|')
    }
  } else if (rest.length === 2) {
    author = rest[0]
    text = rest[1]
  } else {
    text = rest.join('|')
  }

  let typeTag: CriticTypeTag = 'NOTE'
  const tagMatch = text.match(ANY_TYPE_TAG_RE)
  if (tagMatch) {
    typeTag = tagMatch[1] as CriticTypeTag
    text = text.slice(tagMatch[0].length)
  }

  return {
    id,
    author: author ? unescapeCommentText(author) : null,
    date,
    typeTag: TYPE_TAGS.includes(typeTag) ? typeTag : 'NOTE',
    body: unescapeCommentText(text),
  }
}

/** Small stable hash for content-derived panel entry ids. */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
