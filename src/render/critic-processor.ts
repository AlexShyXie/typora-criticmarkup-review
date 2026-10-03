import { HtmlPostProcessor } from '@typora-community-plugin/core'
import { CriticParser } from '../critic/parser'
import { findConsumedSubstitutionRanges } from '../critic/consumed'
import { SYNTAX } from '../critic/syntax'
import type {
  AdditionToken,
  CommentToken,
  CriticToken,
  DeletionToken,
  HighlightToken,
  SubstitutionToken,
} from '../critic/types'

/**
 * Renders CriticMarkup tokens inside the editor / preview DOM.
 *
 * Strategy: process leaf blocks (`p, h1..h6, li, td, ...`) independently —
 * CriticMarkup never crosses block boundaries. For each block, parse its
 * text content, then wrap markup segments with spans from back to front
 * (so earlier offsets stay valid).
 *
 * Stability contract (critical): Typora watches #write with a
 * MutationObserver and re-runs post-processors on every mutation. A
 * processor that mutates the DOM unconditionally therefore loops forever.
 * Two rules keep this processor quiet:
 *
 * 1. Blocks are content-hashed (`data-critic-sig`); an unchanged block is
 *    never touched, so the observer settles after one re-run.
 * 2. The block containing the caret reveals raw markup through CSS class
 *    toggles only — no text nodes are ever created/destroyed during a
 *    reveal transition, so the caret stays exactly where the user put it.
 *
 * v0.3.0 reveal-unit model: the parser runs in UNMERGED mode, so the
 * anchored `{==text==}` and every `{>>...<<}` block are separate tokens,
 * each with its own `data-critic-raw-key`. The anchor and every comment
 * reveal INDEPENDENTLY (click anchor → `{==text==}` only; click ASK badge →
 * ASK raw only; click REPLY badge → REPLY raw only). Typora-consumed shapes
 * (`{<mark>text</mark>}`, `{<del>old~>new</del>}`) become their own units:
 * revealing them synthesizes the eaten `==` / `~~` via CSS pseudo-elements
 * on the native element, so `{==软件的潜==}` shows complete even after the
 * characters themselves are gone from the DOM.
 */

const LEAF_BLOCK_SELECTOR = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'dd', 'dt', 'figcaption',
].join(',')

const WRAPPER_SELECTOR = 'span[data-critic-seg]'

interface Segment {
  from: number
  to: number
  cls: string
  /** Extra data attributes for anchors (comments). */
  attrs?: Record<string, string>
}

/**
 * One independently revealable piece of CriticMarkup in a block.
 * `from`/`to` are offsets into the block's textContent (DOM space).
 */
export interface RevealUnit {
  from: number
  to: number
  /** is-raw / data-critic-raw-key lookup key (DOM-space raw). */
  key: string
  /** Caret must be at least `margin` inside `from`/`to` to reveal. */
  margin: number
  kind: 'token' | 'consumed-anchor' | 'consumed-subst'
  /** Native mark/del element for consumed kinds. */
  el?: HTMLElement
  /** Parsed token for `kind: 'token'`. */
  token?: CriticToken
}

const parser = new CriticParser()

/** Cheap djb2 hash — only used to detect "block content unchanged". */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Offsets of `el`'s text within `root`'s textContent. */
function textRangeOf(root: HTMLElement, el: HTMLElement): { from: number; to: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let from = -1
  let to = -1
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0
    if (el.contains(node)) {
      if (from === -1) from = acc
      to = acc + len
    }
    acc += len
  }
  return from === -1 ? null : { from, to }
}

/**
 * Element-driven consumed-anchor detection: a native `<mark>` whose text is
 * wrapped in literal braces and directly followed (whitespace only) by a
 * comment token — Typora ate the `==` of the anchored `{==text==}`.
 * Standalone consumed highlights (`{==?? ==}` → `{<mark>?? </mark>}`) are
 * NOT units: Typora's own caret reveal already handles them.
 */
function detectConsumedAnchors(
  block: HTMLElement, text: string, tokens: CriticToken[],
): RevealUnit[] {
  const units: RevealUnit[] = []
  const comments = tokens.filter(t => t.type === 'comment')
  if (comments.length === 0) return units
  block.querySelectorAll<HTMLElement>('mark').forEach(mark => {
    const r = textRangeOf(block, mark)
    if (!r) return
    if (text[r.from - 1] !== '{' || text[r.to] !== '}') return
    const paired = comments.some(t => /^\s*$/.test(text.slice(r.to + 1, t.from)))
    if (!paired) return
    const markText = text.slice(r.from, r.to)
    units.push({
      from: r.from - 1,
      to: r.to + 1,
      key: `{${markText}}`,
      margin: 1,
      kind: 'consumed-anchor',
      el: mark,
    })
  })
  return units
}

/**
 * Element-driven consumed-substitution detection: a native `<del>/<s>/<del>`
 * strikethrough element wrapped in literal braces — Typora ate the `~~` of
 * `{~~old~>new~~}`. The text scan supplies the old/new split; the element
 * check keeps literal `{a~>b}` prose from becoming a phantom token.
 */
function detectConsumedSubstitutions(
  block: HTMLElement, text: string, tokens: CriticToken[],
): RevealUnit[] {
  const skip = tokens.map(t => ({ from: t.from, to: t.to }))
  const candidates = findConsumedSubstitutionRanges(text, skip)
  const units: RevealUnit[] = []
  if (candidates.length === 0) return units
  block.querySelectorAll<HTMLElement>('del, s, strike').forEach(del => {
    const r = textRangeOf(block, del)
    if (!r) return
    if (text[r.from - 1] !== '{' || text[r.to] !== '}') return
    const cand = candidates.find(c => c.from === r.from - 1 && c.to === r.to + 1)
    if (!cand) return
    units.push({
      from: cand.from,
      to: cand.to,
      key: cand.raw,
      margin: 1,
      kind: 'consumed-subst',
      el: del,
    })
  })
  return units
}

/** Tokens + consumed shapes, ordered by position. */
function buildRevealUnits(
  block: HTMLElement, text: string, tokens: CriticToken[],
): RevealUnit[] {
  const units: RevealUnit[] = []
  for (const token of tokens) {
    units.push({
      from: token.from,
      to: token.to,
      key: token.raw,
      margin: 3,
      kind: 'token',
      token,
    })
  }
  units.push(...detectConsumedAnchors(block, text, tokens))
  units.push(...detectConsumedSubstitutions(block, text, tokens))
  units.sort((a, b) => a.from - b.from || a.to - b.to)
  return units
}

/** Convert a unit into a CriticToken-ish for the cursor write-back paths. */
export function unitToToken(unit: RevealUnit, text: string): CriticToken | null {
  if (unit.kind === 'token' && unit.token) return unit.token
  if (unit.kind === 'consumed-anchor') {
    return {
      type: 'highlight',
      from: unit.from,
      to: unit.to,
      raw: unit.key,
      text: text.slice(unit.from + 1, unit.to - 1),
      section: '',
    } as HighlightToken
  }
  if (unit.kind === 'consumed-subst') {
    const inner = text.slice(unit.from + 1, unit.to - 1)
    const join = inner.indexOf(SYNTAX.SUBSTITUTION_JOIN)
    if (join < 0) return null
    return {
      type: 'substitution',
      from: unit.from,
      to: unit.to,
      raw: unit.key,
      oldText: inner.slice(0, join),
      newText: inner.slice(join + SYNTAX.SUBSTITUTION_JOIN.length),
      section: '',
    } as SubstitutionToken
  }
  return null
}

/**
 * Resolve the CriticMarkup unit under the editor caret, for the
 * cursor-scoped commands (strip / accept / reject). Boundaries are
 * generous: any caret position from the opening delimiter through the
 * closing one counts as "inside".
 */
export function findCursorTarget(): { token: CriticToken; block: HTMLElement } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  const node = r.startContainer
  if (!node) return null
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  if (!el) return null
  const block = el.closest<HTMLElement>(LEAF_BLOCK_SELECTOR)
  if (!block) return null

  const pre = document.createRange()
  pre.selectNodeContents(block)
  try {
    pre.setEnd(r.startContainer, r.startOffset)
  } catch {
    return null
  }
  const intra = pre.toString().length

  const text = block.textContent ?? ''
  if (!text.includes('{')) return null
  const tokens = parser.parseTokens(text, { mergeAnchored: false })
  const units = buildRevealUnits(block, text, tokens)
  for (const u of units) {
    if (intra >= u.from && intra <= u.to) {
      const token = unitToToken(u, text)
      if (token) return { token, block }
    }
  }
  return null
}

export class CriticRenderService {
  acceptedView = false

  private processor: HtmlPostProcessor | null = null
  private lastCaretBlock: HTMLElement | null = null

  buildProcessor(): HtmlPostProcessor {
    if (this.processor) return this.processor
    this.processor = HtmlPostProcessor.from({
      selector: '',
      process: (el: HTMLElement) => this.process(el),
    })
    return this.processor
  }

  /** Re-render all critic markup within `containerEl` (editor or preview). */
  process(containerEl: HTMLElement): void {
    const caret = this.findCaret(containerEl)

    const blocks = containerEl.querySelectorAll<HTMLElement>(LEAF_BLOCK_SELECTOR)
    blocks.forEach(block => {
      // Only leaves are processed (skip containers with nested blocks).
      if (block.querySelector(LEAF_BLOCK_SELECTOR)) return
      if (caret && block === caret.block) {
        this.processCaretBlock(block, caret.offset, caret.anchorEl)
      } else {
        this.processBlock(block)
      }
    })
  }

  /**
   * selectionchange hook. Never short-circuits on "same block": the caret's
   * unit membership may have changed within the block, and Typora may have
   * rebuilt the block internals underneath us — both need a re-evaluation
   * (cheap: signature + wrapper-presence checks inside short-circuit when
   * nothing actually changed).
   */
  handleCaretMove(containerEl: HTMLElement): void {
    const caret = this.findCaret(containerEl)
    if (!caret) {
      // Caret left the editor (panel / modal / elsewhere): re-wrap the
      // block that was showing raw markup, if any.
      const prev = this.lastCaretBlock
      this.lastCaretBlock = null
      if (prev && prev.isConnected && containerEl.contains(prev)) {
        this.processBlock(prev)
      }
      return
    }
    if (caret.block === this.lastCaretBlock) {
      // Same block — unit membership may still differ; re-evaluate.
      this.processCaretBlock(caret.block, caret.offset, caret.anchorEl)
      return
    }
    const prev = this.lastCaretBlock
    if (prev && prev.isConnected && containerEl.contains(prev)) {
      this.processBlock(prev)
    }
    this.processCaretBlock(caret.block, caret.offset, caret.anchorEl)
  }

  /** Force full reveal of raw markup (plugin unload, accepted-view toggle). */
  unwrapAll(containerEl: HTMLElement): void {
    containerEl.querySelectorAll<HTMLElement>(LEAF_BLOCK_SELECTOR).forEach(block => {
      this.unwrapBlock(block)
    })
    this.lastCaretBlock = null
  }

  // ------------------------------------------------------------- internals

  /**
   * Typora-native semantics: the caret reveals raw markup only for the ONE
   * unit it sits inside (like typing inside `**bold**` shows the stars).
   * All tokens are ALWAYS wrapped — raw vs rendered is a pure CSS class
   * toggle on the revealed unit's segments. Text nodes are never
   * created/destroyed during a reveal transition, so the caret stays put.
   */
  private processCaretBlock(block: HTMLElement, caretOffset: number, anchorEl: HTMLElement | null): void {
    this.lastCaretBlock = block
    const text = block.textContent ?? ''
    const tokens = text.includes('{')
      ? parser.parseTokens(text, { mergeAnchored: false })
      : []
    const units = buildRevealUnits(block, text, tokens)
    this.syncConsumedClasses(block, units)

    // 1) Caret-based reveal: the unit whose interior (with margins) holds
    //    the caret. Consumed units use margin 1 (`{`/`}` only); token units
    //    use 3 (`{==`, `{>>`, …).
    let reveal = this.revealUnitForCaret(units, caretOffset)

    // 2) Click-based reveal: the click landed on rendered chrome (our
    //    wrapper, a consumed mark, a consumed del) — reveal THAT unit only.
    if (!reveal && anchorEl) {
      reveal = this.revealTargetByWrapper(block, anchorEl, units)
    }

    const caretSig = (this.acceptedView ? 'A:' : '') + 'C:' + units.length
    const hashSig = (this.acceptedView ? 'A:' : '') + text.length + ':' + hashText(text)
    const stored = block.dataset.criticSig
    const expectWraps = tokens.length > 0 || units.some(u => u.kind !== 'token')
    const staleKey = reveal !== null && reveal.kind === 'token'
      && !this.hasWrapperForKey(block, reveal.key)
    // Structure is valid when the stored signature matches either the caret
    // format (same unit count — typing inside a token keeps spans intact)
    // or the hash format (text unchanged since the last full render), AND
    // the wrappers are actually present (Typora may have rebuilt the block),
    // AND the revealed unit's wrapper actually exists (stale-key self-heal).
    if ((stored !== caretSig && stored !== hashSig)
      || !this.wrappersMatch(block, expectWraps)
      || staleKey) {
      // Rewrap (rare: Typora rebuilt the block). The surgery destroys text
      // nodes — restore the caret to its exact offset afterwards, or the
      // browser flings it to the block start.
      this.unwrapBlock(block)
      const segments: Segment[] = []
      for (const token of tokens) {
        this.planToken(token, segments)
      }
      for (const unit of units) {
        if (unit.kind === 'consumed-subst') {
          this.planConsumedSubstSegments(unit, text, segments)
        }
      }
      if (segments.length > 0) {
        segments
          .slice()
          .sort((a, b) => b.from - a.from)
          .forEach(seg => this.wrapSegment(block, seg))
      }
      block.dataset.criticSig = caretSig
      this.restoreCaret(block, caretOffset)
    }
    this.syncRawState(block, reveal)
  }

  /** The unit whose interior (margin-adjusted) contains the caret offset. */
  private revealUnitForCaret(units: RevealUnit[], caretOffset: number): RevealUnit | null {
    if (caretOffset < 0) return null
    for (const u of units) {
      if (caretOffset >= u.from + u.margin && caretOffset <= u.to - u.margin) return u
    }
    return null
  }

  private hasWrapperForKey(block: HTMLElement, key: string): boolean {
    return block.querySelector(`[data-critic-raw-key="${CSS.escape(key)}"]`) !== null
  }

  /**
   * Which unit should go raw for a click that landed on rendered chrome?
   * - One of our segment spans (chip / mark / anchor / subst segment): its
   *   unit by raw key.
   * - A consumed anchor mark or consumed substitution del: that unit
   *   (click inside the native element reveals ITS source).
   */
  private revealTargetByWrapper(
    block: HTMLElement, anchorEl: HTMLElement, units: RevealUnit[],
  ): RevealUnit | null {
    const wrapper = anchorEl.closest<HTMLElement>('[data-critic-raw-key]')
    if (wrapper && block.contains(wrapper)) {
      const key = wrapper.dataset.criticRawKey ?? ''
      const unit = units.find(u => u.key === key)
      if (unit) return unit
    }
    for (const u of units) {
      if (u.kind !== 'token' && u.el && u.el.contains(anchorEl)) return u
    }
    return null
  }

  /** Cosmetic classes on the native consumed elements (idempotent). */
  private syncConsumedClasses(block: HTMLElement, units: RevealUnit[]): void {
    block.querySelectorAll<HTMLElement>('mark').forEach(mark => {
      const isUnit = units.some(u => u.kind === 'consumed-anchor' && u.el === mark)
      mark.classList.toggle('critic-anchor-consumed', isUnit && !this.acceptedView)
    })
    block.querySelectorAll<HTMLElement>('del, s, strike').forEach(del => {
      const isUnit = units.some(u => u.kind === 'consumed-subst' && u.el === del)
      del.classList.toggle('critic-consumed-del', isUnit)
    })
  }

  /** Put the caret back at `offset` within `block` after DOM surgery. */
  private restoreCaret(block: HTMLElement, offset: number): void {
    if (offset < 0) return
    const pos = this.findPosition(block, offset)
    if (!pos) return
    try {
      const r = document.createRange()
      r.setStart(pos.node, pos.offset)
      r.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    } catch { /* best effort */ }
  }

  /**
   * Toggle the raw-source classes for the revealed unit (CSS-only):
   * - token / consumed-subst units: `.is-raw` on every segment carrying the
   *   unit's raw key (chips flatten; consumed-subst segments flatten and
   *   the join `~>` unfolds).
   * - consumed-anchor: `.critic-anchor-reveal` on the native mark (CSS
   *   synthesizes the eaten `==` on both sides).
   * Every other element's reveal state is cleared each pass.
   */
  private syncRawState(block: HTMLElement, reveal: RevealUnit | null): void {
    const rawKey = reveal ? reveal.key : null
    const segs = block.querySelectorAll<HTMLElement>('[data-critic-raw-key]')
    segs.forEach(s => s.classList.toggle('is-raw', !!rawKey && s.dataset.criticRawKey === rawKey))
    block.querySelectorAll<HTMLElement>('.critic-anchor-reveal').forEach(el => {
      if (!reveal || reveal.kind !== 'consumed-anchor' || reveal.el !== el) {
        el.classList.remove('critic-anchor-reveal')
      }
    })
    block.querySelectorAll<HTMLElement>('.critic-subst-reveal').forEach(el => {
      if (!reveal || reveal.kind !== 'consumed-subst' || reveal.el !== el) {
        el.classList.remove('critic-subst-reveal')
      }
    })
    if (reveal?.kind === 'consumed-anchor' && reveal.el) {
      reveal.el.classList.add('critic-anchor-reveal')
    }
    if (reveal?.kind === 'consumed-subst' && reveal.el) {
      reveal.el.classList.add('critic-subst-reveal')
    }
  }

  private wrappersMatch(block: HTMLElement, expected: boolean): boolean {
    return (block.querySelector(WRAPPER_SELECTOR) !== null) === expected
  }

  private processBlock(block: HTMLElement): void {
    const text = block.textContent ?? ''
    const tokens = text.includes('{')
      ? parser.parseTokens(text, { mergeAnchored: false })
      : []
    const units = buildRevealUnits(block, text, tokens)
    this.syncConsumedClasses(block, units)

    const sig = (this.acceptedView ? 'A:' : '') + text.length + ':' + hashText(text)
    const stored = block.dataset.criticSig
    const expectWraps = tokens.length > 0 || units.some(u => u.kind !== 'token')
    if (stored === sig
      && this.wrappersMatch(block, expectWraps)) {
      // Fully rendered and current — just make sure no raw reveal lingers
      // (the block may have just lost the caret).
      this.syncRawState(block, null)
      return
    }
    // A caret-format signature (C:count) with wrappers still present means
    // the block was the caret block and is structurally fine — clear the
    // raw reveal without a needless unwrap/rewrap round.
    if (stored?.startsWith('C:') && this.wrappersMatch(block, expectWraps)) {
      this.syncRawState(block, null)
      return
    }

    this.unwrapBlock(block)

    const segments: Segment[] = []
    for (const token of tokens) {
      this.planToken(token, segments)
    }
    for (const unit of units) {
      if (unit.kind === 'consumed-subst') {
        this.planConsumedSubstSegments(unit, text, segments)
      }
    }
    if (segments.length === 0) return

    // Back-to-front so earlier offsets remain valid while we mutate the DOM.
    segments
      .slice()
      .sort((a, b) => b.from - a.from)
      .forEach(seg => this.wrapSegment(block, seg))

    block.dataset.criticSig = sig
    this.syncRawState(block, null)
  }

  private unwrapBlock(block: HTMLElement): void {
    if (block.querySelector(WRAPPER_SELECTOR)) {
      block.querySelectorAll(WRAPPER_SELECTOR).forEach(el => {
        if (!(el instanceof HTMLElement)) return
        const parent = el.parentNode
        if (!parent) return
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
      })
      // Merge fragmented text nodes so offsets map cleanly next run.
      block.normalize()
    }
    delete block.dataset.criticSig
  }

  /** Caret position as { leaf block, character offset, anchor element }. */
  private findCaret(containerEl: HTMLElement): {
    block: HTMLElement; offset: number; anchorEl: HTMLElement
  } | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    const node = r.startContainer
    if (!node || !containerEl.contains(node)) return null
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
    if (!el || !containerEl.contains(el)) return null
    const block = el.closest<HTMLElement>(LEAF_BLOCK_SELECTOR)
    if (!block || !containerEl.contains(block)) return null

    // Character offset via Range.toString(): works when the caret sits in a
    // TEXT node AND when it sits in an ELEMENT node (clicks on styled spans,
    // pseudo-element areas, <br>…) — the TreeWalker approach returned -1 for
    // element containers, which made chip areas permanently un-revealable.
    const pre = document.createRange()
    pre.selectNodeContents(block)
    try {
      pre.setEnd(r.startContainer, r.startOffset)
    } catch {
      return { block, offset: -1, anchorEl: el }
    }
    return { block, offset: pre.toString().length, anchorEl: el }
  }

  private planToken(token: CriticToken, segments: Segment[]): void {
    const { acceptedView } = this
    const mark = segments.length
    const nav = (t: CriticToken): Record<string, string> => ({ 'data-critic-nav-key': t.raw })
    switch (token.type) {
      case 'addition': {
        const t = token as AdditionToken
        segments.push(
          { from: t.from, to: t.from + 3, cls: 'critic-mark' },
          { from: t.from + 3, to: t.to - 3, cls: 'critic-addition', attrs: nav(t) },
          { from: t.to - 3, to: t.to, cls: 'critic-mark' },
        )
        break
      }
      case 'deletion': {
        const t = token as DeletionToken
        segments.push(
          { from: t.from, to: t.to, cls: acceptedView ? 'critic-hidden' : 'critic-deletion', attrs: nav(t) },
        )
        break
      }
      case 'substitution': {
        const t = token as SubstitutionToken
        const join = t.raw.indexOf(SYNTAX.SUBSTITUTION_JOIN)
        if (acceptedView) {
          segments.push(
            { from: t.from, to: t.from + join + 2, cls: 'critic-hidden' },
            { from: t.from + join + 2, to: t.to - 3, cls: 'critic-subst-new', attrs: nav(t) },
            { from: t.to - 3, to: t.to, cls: 'critic-hidden' },
          )
        } else {
          segments.push(
            { from: t.from, to: t.from + 3, cls: 'critic-mark' },
            { from: t.from + 3, to: t.from + join, cls: 'critic-subst-old', attrs: nav(t) },
            { from: t.from + join, to: t.from + join + 2, cls: 'critic-mark' },
            { from: t.from + join + 2, to: t.to - 3, cls: 'critic-subst-new' },
            { from: t.to - 3, to: t.to, cls: 'critic-mark' },
          )
        }
        break
      }
      case 'highlight': {
        const t = token as HighlightToken
        segments.push(
          { from: t.from, to: t.from + 3, cls: 'critic-mark' },
          { from: t.from + 3, to: t.to - 3, cls: 'critic-highlight', attrs: nav(t) },
          { from: t.to - 3, to: t.to, cls: 'critic-mark' },
        )
        break
      }
      case 'comment': {
        const t = token as CommentToken
        this.planComment(t, segments)
        break
      }
    }
    // Stamp every segment of this token with its raw key: the caret-reveal
    // toggle (is-raw) targets these spans by value — CSS-only, no unwrap.
    // Unmerged parsing means one token = one reveal unit = one key, so the
    // anchor and every comment reveal independently.
    for (let i = mark; i < segments.length; i++) {
      const s = segments[i]
      s.attrs = { ...(s.attrs ?? {}), 'data-critic-raw-key': token.raw }
    }
  }

  /**
   * Comment chip: a small badge; the raw text stays in the DOM (hidden
   * via font-size: 0) so copy / write-back / unwrap all keep working.
   * (Anchored pairs are NOT merged here — the renderer parses unmerged,
   * so the anchor highlight is planned by planToken's highlight branch.)
   */
  private planComment(t: CommentToken, segments: Segment[]): void {
    const chipCls = this.acceptedView
      ? 'critic-hidden'
      : `critic-comment-chip critic-chip-${t.typeTag}`
    const attrs: Record<string, string> = {
      'data-critic-nav-key': t.raw,
      'data-critic-comment': '1',
      'data-critic-thread': t.raw,
      title: `${t.author ?? ''}${t.author ? ' · ' : ''}${t.typeTag}\n${t.body}`,
    }
    segments.push({
      from: t.from,
      to: t.to,
      cls: chipCls,
      attrs,
    })
  }

  /**
   * Segments INSIDE a consumed substitution's native `<del>`: old keeps a
   * red line-through (its own — the del's is disabled by CSS), the `~>`
   * join hides, the new text renders green without strike-through.
   */
  private planConsumedSubstSegments(unit: RevealUnit, text: string, segments: Segment[]): void {
    const innerFrom = unit.from + 1
    const innerTo = unit.to - 1
    const innerText = text.slice(innerFrom, innerTo)
    const join = innerText.indexOf(SYNTAX.SUBSTITUTION_JOIN)
    if (join < 0) return
    const joinFrom = innerFrom + join
    const accepted = this.acceptedView
    const mark = segments.length
    segments.push(
      { from: innerFrom, to: joinFrom, cls: accepted ? 'critic-hidden' : 'critic-subst-old' },
      { from: joinFrom, to: joinFrom + 2, cls: 'critic-subst-join' },
      { from: joinFrom + 2, to: innerTo, cls: 'critic-subst-new' },
    )
    for (let i = mark; i < segments.length; i++) {
      const s = segments[i]
      s.attrs = { ...(s.attrs ?? {}), 'data-critic-raw-key': unit.key }
    }
  }

  private wrapSegment(block: HTMLElement, seg: Segment): void {
    const range = document.createRange()
    if (!this.locate(range, block, seg.from, seg.to)) return

    const span = document.createElement('span')
    span.className = seg.cls
    span.dataset.criticSeg = '1'
    if (seg.attrs) {
      for (const [k, v] of Object.entries(seg.attrs)) span.setAttribute(k, v)
    }
    try {
      const frag = range.extractContents()
      span.appendChild(frag)
      range.insertNode(span)
    } catch {
      // Range crossing an element boundary in a way extract cannot handle —
      // skip this segment rather than break the block.
    }
  }

  private locate(range: Range, block: HTMLElement, from: number, to: number): boolean {
    const start = this.findPosition(block, from)
    const end = this.findPosition(block, to)
    if (!start || !end) return false
    try {
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
    } catch {
      return false
    }
    return true
  }

  private findPosition(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
    let acc = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0
      if (acc + len >= offset) {
        return { node, offset: offset - acc }
      }
      acc += len
    }
    return null
  }
}
