import { editor } from 'typora'
import type { App, PluginSettings } from '@typora-community-plugin/core'
import { CriticParser } from '../critic/parser'
import {
  acceptToken,
  rejectToken,
  acceptAll as acceptAllText,
  rejectAll as rejectAllText,
} from '../critic/resolve'
import {
  buildThreadMarkupWithReply,
  buildThreadRemoval,
  buildThreadWithEditedReply,
  buildThreadWithNewBody,
  commentNavKey,
} from '../critic/thread'
import type {
  ChangePanelEntry,
  CommentPanelEntry,
  CommentToken,
  CommentThread,
  CriticToken,
  HighlightToken,
  SubstitutionToken,
} from '../critic/types'
import type { ReviewPanelData, ReviewViewActions } from '../panel/review-view'
import type { ReviewSettings } from '../settings/model'
import { replaceSelectionWith } from '../actions/writeback'
import { locateOffset } from '../critic/text-offset'

/**
 * Central data flow: parse the live markdown, feed the panel, and perform
 * write-backs (accept / reject / edit / reply / resolve) through the editor
 * paste pipeline. One instance per plugin.
 */
export class ReviewController {

  readonly parser = new CriticParser()
  private panel: ReviewViewActions | null = null
  /** Suppresses refresh while the panel itself is committing a write-back. */
  private suppressRefresh = false
  /** Re-render hook fired after write-backs (wired by main to the renderer). */
  private afterWrite: (() => void) | null = null

  constructor(
    private readonly app: App,
    private readonly settings: PluginSettings<ReviewSettings>,
  ) {}

  attachPanel(panel: ReviewViewActions): void {
    this.panel = panel
  }

  detachPanel(): void {
    this.panel = null
  }

  /** Fired after every write-back; main wires it to re-render the editor. */
  setAfterWrite(fn: (() => void) | null): void {
    this.afterWrite = fn
  }

  // ------------------------------------------------------------- data flow

  getMarkdown(): string {
    return editor.getMarkdown()
  }

  parseCurrent(): { changes: ChangePanelEntry[]; comments: CommentPanelEntry[] } {
    const md = this.getMarkdown()
    return {
      changes: this.parser.buildChangeEntries(md),
      comments: this.parser.buildCommentEntries(md),
    }
  }

  panelData(): ReviewPanelData {
    const { changes, comments } = this.parseCurrent()
    return {
      changes,
      comments,
      acceptedView: this.settings.get('acceptedViewEnabled'),
      authorName: this.settings.get('authorName'),
    }
  }

  refreshPanel(force = false): void {
    if (this.suppressRefresh) return
    this.panel?.refresh(this.panelData(), force)
  }

  withSuppressedRefresh(fn: () => void): void {
    this.suppressRefresh = true
    try {
      fn()
    } finally {
      this.suppressRefresh = false
    }
  }

  // ------------------------------------------------------------ navigation

  navigateTo(el: HTMLElement | null, caretKey?: string): void {
    if (!el) {
      editor.EditHelper.showNotification('CriticMarkup: location not found in editor')
      return
    }
    // Park the caret INSIDE the token's delimiters (`{>>|…`): the caret
    // logic then reveals that token's source automatically — panel clicks
    // double as "show me the source" (v0.2.2).
    if (caretKey) this.moveCaretToKey(caretKey, el)
    // Scroll only afterwards; the caret placement already flips raw mode.
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  /** Collapse the caret just inside the delimiters of the `key` markup. */
  private moveCaretToKey(key: string, nearEl: HTMLElement): void {
    try {
      const root = editor.writingArea
      if (!root || !key) return
      const { nodes, starts, stream } = this.readTextStream(root)
      const target = streamIndexOfEl(nearEl, nodes, starts)
      // Source spelling first; post-reload the consumed spelling (`{text}`,
      // `{a~>b}`) is what the DOM actually holds (v0.3.0).
      let best = -1
      for (const cand of [key, ...consumedAlternates(key)]) {
        let idx = stream.indexOf(cand)
        while (idx !== -1) {
          if (best === -1
            || (target >= 0 && Math.abs(idx - target) < Math.abs(best - target))) {
            best = idx
          }
          if (target >= 0 && idx >= target) break
          idx = stream.indexOf(cand, idx + 1)
        }
        if (best !== -1) break
      }
      if (best === -1) return
      // preferEnd: a caret landing exactly on a text node's end stays on
      // that node — the next one may belong to the following block, and
      // parking there would reveal/attach to the wrong line (v0.3.1).
      const pos = locateOffset(nodes, starts, best + 3, true)
      if (!pos) return
      const r = document.createRange()
      r.setStart(pos.node, pos.offset)
      r.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    } catch { /* best effort */ }
  }

  findNavTarget(navKey: string): HTMLElement | null {
    const byAttr = scanByAttribute(editor.writingArea, 'data-critic-nav-key', navKey)
    if (byAttr) return byAttr
    // The block may be currently un-wrapped (caret inside shows raw markup):
    // fall back to locating the raw text in the live text stream.
    const byText = this.locateBlockByText(navKey)
    if (byText) return byText
    // Post-reload the highlight/substitution raw is consumed by Typora's
    // native parser (`==`/`~~` gone from the DOM); try the consumed
    // spelling too (v0.3.0).
    for (const alt of consumedAlternates(navKey)) {
      const hit = this.locateBlockByText(alt)
      if (hit) return hit
    }
    return null
  }

  /** Leaf block containing the first occurrence of `raw` in #write text. */
  private locateBlockByText(raw: string): HTMLElement | null {
    const root = editor.writingArea
    if (!root || !raw) return null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let stream = ''
    let node: Node | null
    const nodes: Text[] = []
    while ((node = walker.nextNode())) {
      nodes.push(node as Text)
      stream += node.textContent ?? ''
      if (stream.length >= raw.length) {
        const idx = stream.indexOf(raw)
        if (idx !== -1) {
          // Walk back to the node containing idx.
          let acc = 0
          for (const t of nodes) {
            const len = t.textContent?.length ?? 0
            if (idx < acc + len) {
              const el = t.parentElement?.closest<HTMLElement>(
                'p,h1,h2,h3,h4,h5,h6,li,td,th,dd,dt,figcaption')
              return el ?? null
            }
            acc += len
          }
        }
        return null
      }
    }
    return null
  }

  findThreadAnchor(threadKey: string): HTMLElement | null {
    return scanByAttribute(editor.writingArea, 'data-critic-thread', threadKey)
  }

  // ------------------------------------------------------------- write-back

  acceptChange(entry: ChangePanelEntry): void {
    this.replaceToken(entry.token, acceptToken(entry.token))
  }

  rejectChange(entry: ChangePanelEntry): void {
    this.replaceToken(entry.token, rejectToken(entry.token))
  }

  acceptAll(): void {
    this.replaceAllDocument(next => acceptAllText(next.md, next.tokens))
  }

  rejectAll(): void {
    this.replaceAllDocument(next => rejectAllText(next.md, next.tokens))
  }

  /**
   * Whole-document replacement: select everything in `#write` and paste the
   * transformed markdown. One undo step, no stale-DOM risk from chained
   * per-token write-backs.
   */
  private replaceAllDocument(
    transform: (state: { md: string; tokens: CriticToken[] }) => string,
  ): void {
    const md = this.getMarkdown()
    const tokens = this.parser.parseTokens(md)
    const nextMd = transform({ md, tokens })
    if (nextMd === md) return

    const write = editor.writingArea
    if (!write) return
    const range = document.createRange()
    range.selectNodeContents(write)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    replaceSelectionWith(editor, nextMd)
    this.refreshSoon()
  }

  navigateChange(entry: ChangePanelEntry): void {
    this.navigateTo(this.findNavTarget(entry.token.raw), entry.token.raw)
  }

  /**
   * Jump to one comment token: the thread head by default, or the reply at
   * `replyIndex` when a reply row was clicked (v0.4.5 — every comment block,
   * replies included, is its own reveal unit with its own chip / nav key, so
   * the row that was clicked is the row we land on).
   */
  navigateComment(entry: CommentPanelEntry, replyIndex?: number): void {
    const reply = replyIndex === undefined ? null : entry.thread.replies[replyIndex] ?? null
    const token = reply ?? entry.thread.first
    const key = commentNavKey(token)
    this.navigateTo(this.findNavTarget(key), key)
  }

  editComment(entry: CommentPanelEntry, newBody: string, newTag: string): void {
    const { thread } = entry
    const rewritten = buildThreadWithNewBody(
      thread.raw,
      this.settings.get('authorName'),
      newTag as never,
      newBody,
    )
    this.replaceThread(thread, rewritten)
  }

  replyComment(entry: CommentPanelEntry, replyBody: string): void {
    const { thread } = entry
    const author = this.settings.get('authorName')
    const upgraded = buildThreadMarkupWithReply(
      thread.raw,
      thread.first.author ?? author,
      thread.first.typeTag,
      thread.first.body,
      author,
      replyBody,
    )
    this.replaceThread(thread, upgraded)
  }

  /**
   * Rewrite ONLY the reply at `replyIndex` inside the thread, keeping the
   * anchor, first comment and all other replies untouched (v0.3.0).
   */
  editReply(entry: CommentPanelEntry, replyIndex: number, body: string): void {
    const { thread } = entry
    const rewritten = buildThreadWithEditedReply(
      thread.raw,
      replyIndex,
      this.settings.get('authorName'),
      body,
    )
    if (rewritten === thread.raw) return
    this.replaceThread(thread, rewritten)
  }

  resolveComment(entry: CommentPanelEntry): void {
    const { thread } = entry
    if (thread.anchor) {
      // Resolve keeps the anchored text as PLAIN text: the whole
      // `{==..==}{>>..<<}` region collapses to the anchor text.
      const key = commentNavKey(thread.first)
      const hint = this.findThreadAnchor(key) ?? this.findNavTarget(key)
      // Pre-reload the DOM holds the literal highlight; after a Typora
      // reload the `{==..==}` is consumed into a native <mark> and the DOM
      // shows `{text}` instead — try both spellings.
      const pairs = [
        { expected: thread.raw, replacement: thread.anchor.text },
        { expected: '{' + thread.anchor.text + '}' + key, replacement: thread.anchor.text },
      ]
      this.replaceFirstMatch(pairs, hint)
      return
    }
    // Resolve keeps the anchored text but removes highlight + comments.
    this.replaceThread(thread, buildThreadRemoval())
  }

  /**
   * Remove the CriticMarkup syntax at the cursor, keeping the meaningful
   * content (accept semantics): additions/substitutions keep their text,
   * deletions vanish, highlights keep their text, comments are removed.
   *
   * v0.3.0: tokens arrive from the UNMERGED DOM-space parse (renderer's
   * reveal units), so the scope is exactly the unit the cursor sits in —
   * the anchor strips `{==..==}` alone; each comment block strips alone.
   * `hintEl` (the block under the caret) disambiguates duplicate raws.
   */
  stripToken(token: CriticToken, hintEl?: HTMLElement | null): void {
    switch (token.type) {
      case 'addition':
        this.replaceToken(token, token.raw.slice(3, -3), hintEl)
        break
      case 'deletion':
        this.replaceToken(token, '', hintEl)
        break
      case 'substitution':
        this.replaceToken(token, (token as SubstitutionToken).newText, hintEl)
        break
      case 'highlight':
        this.replaceToken(token, (token as HighlightToken).text, hintEl)
        break
      case 'comment': {
        const t = token as CommentToken
        if (t.anchored) {
          const key = commentNavKey(t)
          const hint = this.findThreadAnchor(key) ?? this.findNavTarget(key)
          this.replaceFirstMatch([
            { expected: t.raw, replacement: t.anchored.text },
            { expected: '{' + t.anchored.text + '}' + key, replacement: t.anchored.text },
          ], hint)
        } else {
          this.replaceToken(token, '', hintEl)
        }
        break
      }
    }
  }

  /**
   * Accept/reject the DOM-space change token found at the cursor — works
   * per reveal unit and survives the consumed spelling (v0.3.0).
   */
  resolveTokenAt(token: CriticToken, accept: boolean, hintEl?: HTMLElement | null): void {
    this.replaceToken(token, accept ? acceptToken(token) : rejectToken(token), hintEl)
  }

  // ------------------------------------------------------------ primitives

  private replaceToken(token: CriticToken, replacement: string, hintEl?: HTMLElement | null): void {
    const hint = hintEl ?? this.findNavTarget(token.raw)
    this.replaceTextRange(token.raw, replacement, hint)
  }

  private replaceThread(thread: CommentThread, rewritten: string): void {
    const anchored = thread.first.anchored
    const key = commentNavKey(thread.first)
    const hint = this.findThreadAnchor(key) ?? this.findNavTarget(key)
    if (!anchored) {
      this.replaceTextRange(thread.raw, rewritten, hint)
      return
    }
    // Pre-reload the DOM still holds the literal `{==..==}` prefix; after a
    // Typora reload the highlight is consumed into a native <mark> and its
    // `==` never exists in the DOM text — fall back to comment-only scope
    // so the anchor in the markdown source stays untouched.
    this.replaceFirstMatch([
      { expected: thread.raw, replacement: rewritten },
      { expected: key, replacement: rewritten.slice(anchored.highlightRaw.length) },
    ], hint)
  }

  /** Try each expected/replacement pair; the first one found wins. */
  private replaceFirstMatch(
    pairs: Array<{ expected: string; replacement: string }>,
    hintEl: HTMLElement | null,
  ): void {
    const root = editor.writingArea
    if (!root) return
    const { nodes, starts, stream } = this.readTextStream(root)
    const hintStart = this.hintStreamStart(hintEl, nodes, starts)

    for (const pair of pairs) {
      const best = this.locateExpected(stream, pair.expected, hintStart)
      if (best !== -1) {
        this.performReplace(nodes, starts, best, pair.expected, pair.replacement)
        return
      }
    }
    editor.EditHelper.showNotification('CriticMarkup: markup not found (document changed?)')
  }

  private readTextStream(root: HTMLElement): {
    nodes: Text[]; starts: number[]; stream: string
  } {
    const nodes: Text[] = []
    const starts: number[] = []
    const parts: string[] = []
    let total = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node as Text
      nodes.push(text)
      starts.push(total)
      parts.push(text.textContent ?? '')
      total += text.textContent?.length ?? 0
    }
    return { nodes, starts, stream: parts.join('') }
  }

  private hintStreamStart(
    hintEl: HTMLElement | null, nodes: Text[], starts: number[],
  ): number {
    if (!hintEl) return -1
    for (let i = 0; i < nodes.length; i++) {
      if (hintEl.contains(nodes[i])) return starts[i]
    }
    return -1
  }

  /** Nearest-to-hint occurrence of `expected` in the stream, or -1. */
  private locateExpected(stream: string, expected: string, hintStart: number): number {
    if (!expected) return -1
    let best = -1
    let idx = stream.indexOf(expected)
    while (idx !== -1) {
      if (best === -1 || Math.abs(idx - hintStart) < Math.abs(best - hintStart)) {
        best = idx
      }
      if (hintStart >= 0 && idx >= hintStart) break
      idx = stream.indexOf(expected, idx + 1)
    }
    return best
  }

  private performReplace(
    nodes: Text[], starts: number[], best: number,
    expected: string, replacement: string,
  ): void {
    const range = document.createRange()
    // START keeps the default (`<`): the beginning of the token belongs to
    // the node the token starts in. END uses preferEnd, otherwise a token
    // ending exactly at a text node's end hops into the NEXT block and the
    // selection — once replaced with shorter/empty text — swallows the line
    // break (v0.3.1: "strip at end of line merged the next paragraph").
    const start = locateOffset(nodes, starts, best)
    const end = locateOffset(nodes, starts, best + expected.length, true)
    if (!start || !end) {
      editor.EditHelper.showNotification('CriticMarkup: cannot locate range')
      return
    }
    try {
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
    } catch {
      editor.EditHelper.showNotification('CriticMarkup: cannot locate range')
      return
    }

    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    replaceSelectionWith(editor, replacement)
    // Typora rebuilds the pasted block with raw text; the re-wrap normally
    // waits for the framework's ~400ms observer round-trip — that whole
    // window is visible as a "flash of raw markup" (and if the paste left
    // the caret inside the token, raw would stick). Settle early: park the
    // caret past the markup and re-render directly.
    const settle = () => {
      this.parkCaretPast(replacement)
      this.afterWrite?.()
    }
    window.setTimeout(settle, 120)
    window.setTimeout(settle, 420)
    this.refreshSoon(true)
  }

  /**
   * Locate `expected` in the live #write text stream and replace it via the
   * paste pipeline. `hintEl` (a rendered wrapper, when present) only
   * disambiguates duplicate matches — the write itself works on raw text,
   * so it succeeds even when the token's block is currently unwrapped
   * (caret inside).
   */
  private replaceTextRange(
    expected: string,
    replacement: string,
    hintEl: HTMLElement | null,
  ): void {
    const root = editor.writingArea
    if (!root) return

    const { nodes, starts, stream } = this.readTextStream(root)
    const hintStart = this.hintStreamStart(hintEl, nodes, starts)

    // Find the match closest to the hint; without a hint take the first.
    const best = this.locateExpected(stream, expected, hintStart)
    if (best === -1) {
      editor.EditHelper.showNotification('CriticMarkup: markup not found (document changed?)')
      return
    }
    this.performReplace(nodes, starts, best, expected, replacement)
  }

  /**
   * If the caret currently sits inside the just-written markup, move it
   * right after the markup's end (collapsed). No-op otherwise.
   */
  private parkCaretPast(replacement: string): void {
    try {
      const root = editor.writingArea
      const sel = window.getSelection()
      if (!root || !replacement || !sel || sel.rangeCount === 0) return
      const r = sel.getRangeAt(0)
      if (!r.collapsed || !root.contains(r.startContainer)) return

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      const starts: number[] = []
      let total = 0
      let caretAt = -1
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = node as Text
        nodes.push(text)
        starts.push(total)
        if (caretAt === -1 && node === r.startContainer && node.nodeType === Node.TEXT_NODE) {
          caretAt = total + r.startOffset
        }
        total += node.textContent?.length ?? 0
      }
      if (caretAt === -1) return

      const stream = nodes.map(n => n.textContent ?? '').join('')
      // Find the occurrence of the markup that actually contains the caret
      // (identical reply text may legitimately appear twice in the doc).
      let idx = stream.indexOf(replacement)
      let end = -1
      while (idx !== -1) {
        if (caretAt > idx && caretAt < idx + replacement.length) {
          end = idx + replacement.length
          break
        }
        idx = stream.indexOf(replacement, idx + 1)
      }
      if (end === -1) return // caret not inside any occurrence

      // Locate `end` in the live node list and collapse the caret there.
      // preferEnd keeps an end-of-text-node caret on that node instead of
      // dropping it into the next block (v0.3.1).
      const pos = locateOffset(nodes, starts, end, true)
      if (!pos) return
      const nr = document.createRange()
      nr.setStart(pos.node, pos.offset)
      nr.collapse(true)
      sel.removeAllRanges()
      sel.addRange(nr)
    } catch { /* best-effort; never block a write-back */ }
  }

  private refreshSoon(force = true): void {
    // Wait for Typora's re-parse + our processor before refreshing the panel.
    setTimeout(() => this.refreshPanel(force), 450)
  }
}

/**
 * DOM-consumed spellings of a source raw: Typora eats the `==` of
 * `{==text==}` and the `~~` of `{~~a~>b~~}` on reload, so the post-reload
 * DOM text holds `{text}` / `{a~>b}` instead (v0.3.0).
 */
function consumedAlternates(raw: string): string[] {
  const alts: string[] = []
  const hl = raw.match(/^\{==([\s\S]*)==\}$/)
  if (hl) alts.push(`{${hl[1]}}`)
  const subst = raw.match(/^\{~~([\s\S]*)~~\}$/)
  if (subst) {
    const join = subst[1].indexOf('~>')
    if (join >= 0) {
      alts.push(`{${subst[1].slice(0, join)}~>${subst[1].slice(join + 2)}}`)
    }
  }
  return alts
}

function scanByAttribute(
  root: HTMLElement | null,
  attr: string,
  value: string,
): HTMLElement | null {
  if (!root) return null
  const hits = root.querySelectorAll<HTMLElement>(`[${attr}]`)
  for (const el of hits) {
    if (el.getAttribute(attr) === value) return el
  }
  return null
}

/** Stream offset of an element's first text node (for proximity ranking). */
function streamIndexOfEl(el: HTMLElement, nodes: Text[], starts: number[]): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const first = walker.nextNode()
  if (!first) return -1
  const i = nodes.indexOf(first as Text)
  return i >= 0 ? starts[i] : -1
}


