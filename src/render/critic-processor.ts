import { HtmlPostProcessor } from '@typora-community-plugin/core'
import { CriticParser } from '../critic/parser'
import {
  findConsumedAnchorRanges,
  findConsumedSubstitutionRanges,
} from '../critic/consumed'
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
 * ASK raw only; click REPLY badge → REPLY raw only).
 *
 * v0.3.1 TRUTH MODEL (corrects the v0.3.0 "consumed shapes" theory):
 * Typora never removes the `==` / `~~` syntax characters. After a reload
 * `{==text==}` lives in the DOM as `{` + `<mark>` wrapping
 * `<span class="md-meta">==</span>` + text + `<span class="md-meta">==</span>`
 * + `}` — the glyphs are Typora's own `.md-meta` spans, hidden by
 * `.md-meta{display:none}`, and the native mark/del decorations
 * (`mark{background:#ff0}`, del line-through) paint OVER our styles. The
 * renderer therefore only needs to (a) keep the per-unit wrap/reveal model
 * and (b) let the stylesheet take over the native elements and force-show
 * `.md-meta` inside revealed units (style.scss v0.3.1). Typing inside a
 * unit must NEVER rewrap (IME composition safety): see processCaretBlock's
 * caret-stamp fast paths.
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
 * Element-driven consumed-anchor detection (v0.3.2): a native `<mark>`
 * wrapped in literal braces whose `==` Typora already ate — the live editor
 * does that the instant the user finishes typing `{==important==}`, so
 * `textContent` reports `{important}` and the source-form regex can no
 * longer see a token.
 *
 * v0.3.2 change: detection used to require a following `{>>...<<}` comment
 * (plus "directly followed" whitespace), which left STANDALONE consumed
 * anchors completely unwrapped — the user saw Typora's native golden
 * `<mark>` with the literal braces beside it. It is now candidate-driven,
 * exactly like consumed substitutions: `findConsumedAnchorRanges` proposes
 * and the `<mark>` element check rejects prose braces (`{see below}`) and
 * md-meta shapes (still `==text==`, owned by the token path).
 */
function detectConsumedAnchors(
  block: HTMLElement, text: string, tokens: CriticToken[],
): RevealUnit[] {
  const skip = tokens.map(t => ({ from: t.from, to: t.to }))
  const candidates = findConsumedAnchorRanges(text, skip)
  const units: RevealUnit[] = []
  if (candidates.length === 0) return units
  block.querySelectorAll<HTMLElement>('mark').forEach(mark => {
    const r = textRangeOf(block, mark)
    if (!r) return
    if (text[r.from - 1] !== '{' || text[r.to] !== '}') return
    const cand = candidates.find(c => c.from === r.from - 1 && c.to === r.to + 1)
    if (!cand) return
    units.push({
      from: cand.from,
      to: cand.to,
      key: cand.raw,
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
  // v0.3.1: the caret often parks on a wrapper's zero-width boundary (chip
  // badges are font-size: 0) or inside a consumed native element — offset
  // matching then misses ("no markup at cursor" despite a clear target).
  // Fall back to the wrapper the selection anchor sits in, then to the
  // consumed element containing it.
  const wrapper = el.closest<HTMLElement>('[data-critic-raw-key]')
  if (wrapper && block.contains(wrapper)) {
    const key = wrapper.dataset.criticRawKey ?? ''
    const u = units.find(x => x.key === key)
    const token = u ? unitToToken(u, text) : null
    if (token) return { token, block }
  }
  for (const u of units) {
    if (u.kind !== 'token' && u.el && u.el.contains(el)) {
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

  /** v0.3.2 same-frame repair guard (see attachMutationGuard). */
  private guardObserver: MutationObserver | null = null
  private guardRoot: HTMLElement | null = null
  private composing = false
  private surgery = false

  /**
   * v0.4.0 — caret state kept for the guard.
   *
   * `lastCaretOffset` lets the guard keep a block in caret mode when the
   * selection is momentarily unreadable (Typora detaches the caret's text
   * node while it re-renders the line). Without it the guard fell through to
   * `processBlock`, which clears `.is-raw` — that is the "flashes rendered,
   * then back to source" symptom.
   *
   * `lastReveal*` is the last successfully applied reveal, used the same way.
   * `dirtyBlocks` accumulates blocks Typora mutated WHILE an IME composition
   * was running (surgery is forbidden then) so they can be repaired in the
   * compositionend frame itself.
   */
  private lastCaretOffset = -1
  private lastRevealKey: string | null = null
  private lastRevealUnit: RevealUnit | null = null
  private dirtyBlocks = new Set<HTMLElement>()

  private rememberReveal(key: string | null, unit: RevealUnit | null): void {
    this.lastRevealKey = key
    this.lastRevealUnit = unit
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true
    // v0.4.0: mark the caret block so the stylesheet can keep the line from
    // flashing "rendered" while Typora re-renders it mid-composition (DOM
    // surgery is forbidden during a composition).
    this.lastCaretBlock?.classList.add('critic-composing')
  }
  private readonly onCompositionEnd = (): void => {
    this.composing = false
    this.lastCaretBlock?.classList.remove('critic-composing')
    const root = this.guardRoot
    if (!root || !root.isConnected) return
    // v0.4.0: repair SYNCHRONOUSLY in the compositionend frame. The old
    // setTimeout(…, 0) is a macrotask, so the browser was free to paint the
    // half-rebuilt (rendered-looking) line before we restored the source
    // view — one flash per committed character.
    const pending = Array.from(this.dirtyBlocks)
    this.dirtyBlocks.clear()
    const caret = this.findCaret(root)
    const block = caret?.block ?? this.lastCaretBlock
    if (pending.length > 0) {
      this.surgery = true
      try {
        for (const b of pending) {
          if (!b.isConnected || !root.contains(b)) continue
          if (caret && b === caret.block) {
            this.processCaretBlock(b, caret.offset, caret.anchorEl)
          } else {
            this.processBlock(b)
          }
        }
      } finally {
        this.surgery = false
      }
    }
    // The caret block itself may not have produced mutations we recorded
    // (Typora can rebuild it in place), so always re-evaluate it too.
    if (block && block.isConnected && root.contains(block)) {
      if (caret && block === caret.block) {
        this.processCaretBlock(block, caret.offset, caret.anchorEl)
      } else if (!pending.includes(block)) {
        this.processBlock(block)
      }
    }
  }

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
      this.lastCaretOffset = -1
      this.rememberReveal(null, null)
      if (prev && prev.isConnected && containerEl.contains(prev)) {
        this.processBlock(prev)
      }
      return
    }
    this.lastCaretOffset = caret.offset
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

  /**
   * v0.4.0 diagnostic: dump the caret block's text / DOM / computed colours.
   * The anchor's golden-vs-egg-yellow question could not be settled by
   * reading Typora's bundled CSS alone, so the real DOM is made one F1
   * command away (copied to the clipboard + logged to the console).
   */
  debugDump(): string {
    const root = this.guardRoot
    if (!root) return '(no guard root attached)'
    const caret = this.findCaret(root)
    const block = caret?.block ?? this.lastCaretBlock
    if (!block) return '(no caret block)'
    const out: string[] = []
    out.push(`caretOffset=${caret ? caret.offset : 'n/a'}  lastCaretOffset=${this.lastCaretOffset}`)
    out.push(`revealKey=${JSON.stringify(this.lastRevealKey)}`)
    out.push('TEXT: ' + JSON.stringify(block.textContent ?? ''))
    block.querySelectorAll<HTMLElement>('mark, del, s, strike').forEach(el => {
      const cs = window.getComputedStyle(el)
      out.push([
        `<${el.tagName.toLowerCase()}>`,
        `class="${el.className}"`,
        `inline="${el.getAttribute('style') ?? ''}"`,
        `bg=${cs.backgroundColor}`,
        `color=${cs.color}`,
        `deco=${cs.textDecorationLine}`,
      ].join(' '))
    })
    out.push('HTML: ' + (block.outerHTML ?? '').slice(0, 4000))
    return out.join('\n')
  }

  /** Force full reveal of raw markup (plugin unload, accepted-view toggle). */
  unwrapAll(containerEl: HTMLElement): void {
    containerEl.querySelectorAll<HTMLElement>(LEAF_BLOCK_SELECTOR).forEach(block => {
      this.unwrapBlock(block)
    })
    // v0.4.0: our inline !important takeover out-ranks every stylesheet, so
    // it must be undone explicitly or Typora's native highlight stays dead
    // after the plugin unloads.
    this.clearNeutralization(containerEl)
    this.lastCaretBlock = null
    this.lastCaretOffset = -1
    this.rememberReveal(null, null)
    this.dirtyBlocks.clear()
  }

  // ------------------------------------------------------------- internals

  /**
   * Typora-native semantics: the caret reveals raw markup only for the ONE
   * unit it sits inside (like typing inside `**bold**` shows the stars).
   * All tokens are ALWAYS wrapped — raw vs rendered is a pure CSS class
   * toggle on the revealed unit's segments. Text nodes are never
   * created/destroyed during a reveal transition, so the caret stays put.
   *
   * v0.3.1 rewrap policy: the caret block only rewraps when the unit COUNT
   * changed (structure edit) or the wrappers are actually gone. Typing
   * INSIDE a unit keeps the count stable and must not rewrap — a rewrap
   * destroys text nodes, which flashes the block on every keystroke and
   * kills the IME composition session (duplicated CJK input). The reveal
   * stays stable meanwhile because it is keyed off the wrapper's own raw
   * key (see resolveReveal rule 1), which does not drift while typing.
   */
  /**
   * v0.3.2 SAME-FRAME REPAIR GUARD.
   *
   * Typora re-renders a line's inline DOM when the user presses SPACE (that
   * is when its markdown inline parser re-runs), and re-rendering drops our
   * wrapper spans. The community framework only re-runs post-processors
   * after `MutationObserver(debounce(emitEdit, 400))` (core.js), so the raw
   * source text was painted for up to 400ms — the "whole line flashes into
   * source" the user reported.
   *
   * MutationObserver callbacks are microtasks: they run when the task that
   * mutated the DOM ends, i.e. BEFORE the browser paints. Repairing here
   * puts Typora's re-render and our re-wrap in the same frame, so the raw
   * frame never reaches the screen.
   *
   * Deliberately observes childList/characterData only (not attributes):
   * our own `dataset` writes and class toggles must not feed back. Our
   * surgery does produce childList records, but the follow-up pass hits a
   * fast path and changes nothing, so the loop converges in one extra pass.
   */
  attachMutationGuard(root: HTMLElement): void {
    this.detachMutationGuard()
    this.guardRoot = root
    try {
      this.guardObserver = new MutationObserver(records => this.onGuardMutations(records))
      this.guardObserver.observe(root, { childList: true, subtree: true, characterData: true })
    } catch {
      this.guardObserver = null
    }
    root.addEventListener('compositionstart', this.onCompositionStart, true)
    root.addEventListener('compositionend', this.onCompositionEnd, true)
  }

  /** Stop the guard (plugin unload / re-attach). */
  detachMutationGuard(): void {
    this.guardObserver?.disconnect()
    this.guardObserver = null
    const root = this.guardRoot
    if (root) {
      root.removeEventListener('compositionstart', this.onCompositionStart, true)
      root.removeEventListener('compositionend', this.onCompositionEnd, true)
    }
    this.lastCaretBlock?.classList.remove('critic-composing')
    this.guardRoot = null
    this.surgery = false
    this.composing = false
    this.dirtyBlocks.clear()
  }

  dispose(): void {
    this.detachMutationGuard()
    this.lastCaretBlock = null
    this.lastCaretOffset = -1
    this.rememberReveal(null, null)
  }

  private onGuardMutations(records: MutationRecord[]): void {
    const root = this.guardRoot
    if (!root || !root.isConnected) return
    // IME composition and our own surgery never re-enter here (see below for
    // the composition bookkeeping, which moved after block collection).
    if (this.surgery) return
    if (this.acceptedView) return

    const blocks = new Set<HTMLElement>()
    const collect = (node: Node | null): void => {
      if (!node) return
      if (!root.contains(node)) return
      const el = node.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : (node as HTMLElement)
      const block = el?.closest<HTMLElement>(LEAF_BLOCK_SELECTOR) ?? null
      if (block && root.contains(block)) blocks.add(block)
    }
    for (const record of records) {
      collect(record.target)
      // v0.4.0: `record.target` is the PARENT of the change. When Typora
      // swaps a whole leaf block (<p>) the target is #write, whose closest
      // leaf is null — the block was never collected and the repair had to
      // wait for the framework's ~400ms edit round-trip (a long flash).
      record.addedNodes.forEach(collect)
      record.removedNodes.forEach(collect)
    }
    if (blocks.size === 0) return

    // IME composition: never run DOM surgery mid-composition — swapping
    // text nodes under the caret is what duplicated CJK input before.
    // v0.4.0: remember the blocks instead of dropping them, so the repair
    // happens in the compositionend frame (same frame, no painted flash).
    if (this.composing) {
      for (const block of blocks) this.dirtyBlocks.add(block)
      return
    }

    const caret = this.findCaret(root)
    this.surgery = true
    try {
      for (const block of blocks) {
        if (caret && block === caret.block) {
          this.processCaretBlock(block, caret.offset, caret.anchorEl)
        } else if (!caret && block === this.lastCaretBlock) {
          // v0.4.0: the caret is momentarily unreadable (Typora detaches the
          // caret's text node while re-rendering the line). Rendering this
          // block as a normal one would CLEAR its .is-raw — the source view
          // would blink off. Keep it in caret mode with the last known
          // offset; if that resolves nothing, fall back to the remembered
          // reveal key so the unit stays revealed.
          this.processCaretBlock(block, this.lastCaretOffset, null)
          if (this.lastRevealKey && !block.querySelector('[data-critic-raw-key].is-raw')) {
            this.syncRawState(block, this.lastRevealKey, null)
          }
        } else {
          this.processBlock(block)
        }
      }
    } finally {
      this.surgery = false
    }
  }

  private processCaretBlock(block: HTMLElement, caretOffset: number, anchorEl: HTMLElement | null): void {
    this.lastCaretBlock = block
    if (caretOffset >= 0) this.lastCaretOffset = caretOffset
    const text = block.textContent ?? ''
    const tokens = text.includes('{')
      ? parser.parseTokens(text, { mergeAnchored: false })
      : []
    const units = buildRevealUnits(block, text, tokens)
    this.syncConsumedClasses(block, units)

    const reveal = this.resolveReveal(block, caretOffset, anchorEl, units)

    const textSig = (this.acceptedView ? 'A:' : '') + text.length + ':' + hashText(text)
    const caretSig = (this.acceptedView ? 'A:' : '') + 'C:' + units.length
    const expectWraps = tokens.length > 0 || units.some(u => u.kind !== 'token')

    // Fast path A — caret stamp current (typing inside a unit): keep the
    // spans, only sync the reveal classes.
    if (block.dataset.criticCaret === caretSig && this.wrappersMatch(block, expectWraps)) {
      this.rememberReveal(reveal.key, reveal.unit)
      this.syncRawState(block, reveal.key, reveal.unit)
      return
    }
    // Fast path B — text unchanged since the last full wrap: just stamp
    // the caret format. Entering caret mode must NOT rewrap, or the FIRST
    // keystroke after a click would destroy the composition session.
    if (block.dataset.criticSig === textSig && this.wrappersMatch(block, expectWraps)) {
      block.dataset.criticCaret = caretSig
      this.rememberReveal(reveal.key, reveal.unit)
      this.syncRawState(block, reveal.key, reveal.unit)
      return
    }

    // Full rewrap (unit count changed, or Typora rebuilt the block). The
    // surgery destroys text nodes — restore the caret to its exact offset
    // afterwards, or the browser flings it to the block start.
    this.unwrapBlock(block)
    const segments: Segment[] = []
    for (const token of tokens) {
      this.planToken(token, segments)
    }
    for (const unit of units) {
      if (unit.kind === 'consumed-subst') {
        this.planConsumedSubstSegments(unit, text, segments)
      } else if (unit.kind === 'consumed-anchor') {
        // v0.4.0: the caret block used to skip this, so a consumed anchor's
        // literal `{` / `}` stayed visible next to the (native) mark while
        // the caret sat anywhere in the block. processBlock already does it.
        this.planConsumedAnchorSegments(unit, segments)
      }
    }
    if (segments.length > 0) {
      segments
        .slice()
        .sort((a, b) => b.from - a.from)
        .forEach(seg => this.wrapSegment(block, seg))
    }
    block.dataset.criticSig = textSig
    block.dataset.criticCaret = caretSig
    this.restoreCaret(block, caretOffset)
    // v0.4.0: the native mark/del hosting our spans is neutralized by inline
    // !important (CSS alone proved unreliable) — recomputed after every wrap.
    this.neutralizeNativeHosts(block, units)

    // v0.4.0 — THE typing-flash fix.
    // `reveal` was resolved BEFORE the surgery, i.e. off the pre-surgery
    // wrapper span, whose data-critic-raw-key is the raw markup WITHOUT the
    // character the user just typed. The spans we just created carry the NEW
    // key, so syncRawState(reveal.key) matched nothing and the frame painted
    // the RENDERED view; the source view only came back on the next
    // selectionchange (150ms debounce) — one flash per keystroke.
    // Re-locate the caret in the POST-surgery DOM and resolve again: the
    // anchor now sits inside a fresh wrapper carrying the new key (`findCaret`
    // is read-only, so the caret itself is untouched).
    const post = this.findCaret(block)
    const revealAfter = post
      ? this.resolveReveal(block, post.offset, post.anchorEl, units)
      : { key: null, unit: null }
    this.rememberReveal(revealAfter.key, revealAfter.unit)
    this.syncRawState(block, revealAfter.key, revealAfter.unit)
  }

  /** The unit whose interior (margin-adjusted) contains the caret offset. */
  private revealUnitForCaret(units: RevealUnit[], caretOffset: number): RevealUnit | null {
    if (caretOffset < 0) return null
    for (const u of units) {
      if (caretOffset >= u.from + u.margin && caretOffset <= u.to - u.margin) return u
    }
    return null
  }

  /**
   * v0.3.1 reveal resolution, in priority order:
   * 1. The wrapper span the caret/click anchor sits in — reveal its OWN
   *    raw key even when typing has already drifted the parsed raw (this
   *    is what keeps the reveal rock-stable while editing a unit).
   * 2. The unit whose margin-adjusted range holds the caret offset
   *    (consumed units margin 1 `{`/`}`, token units 3 `{==`, `{>>`, …).
   * 3. A consumed native element (mark/del) containing the anchor.
   *
   * `key` and `unit` are decoupled on purpose: rule 1 can produce a key
   * that no longer matches any parsed unit (mid-typing), and syncRawState
   * must still reveal it.
   */
  private resolveReveal(
    block: HTMLElement, caretOffset: number, anchorEl: HTMLElement | null,
    units: RevealUnit[],
  ): { key: string | null; unit: RevealUnit | null } {
    if (anchorEl) {
      const wrapper = anchorEl.closest<HTMLElement>('[data-critic-raw-key]')
      if (wrapper && block.contains(wrapper)) {
        const key = wrapper.dataset.criticRawKey ?? ''
        if (key) return { key, unit: units.find(u => u.key === key) ?? null }
      }
    }
    const byOffset = this.revealUnitForCaret(units, caretOffset)
    if (byOffset) return { key: byOffset.key, unit: byOffset }
    if (anchorEl) {
      const byEl = units.find(u => u.kind !== 'token' && u.el && u.el.contains(anchorEl))
      if (byEl) return { key: byEl.key, unit: byEl }
    }
    return { key: null, unit: null }
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
    // Runs on every pass (fast paths included): Typora can drop the class
    // when it re-renders a block, and the golden mark would come back.
    this.neutralizeNativeHosts(block, units)
  }

  /**
   * v0.4.0: neutralize every native element that HOSTS our wrapper spans —
   * by INLINE `!important`, which no external stylesheet rule can outrank.
   *
   * History: v0.3.1 relied on `mark:has([data-critic-raw-key])` and v0.3.2
   * added the plain-class fallback `mark.critic-native-host`, both setting
   * `background: transparent !important`. Typora's only golden source is
   * `mark{background:#ff0}` (base.css, specificity 0-0-1, no !important), so
   * both should have won — yet the anchor still rendered golden. Rather than
   * keep guessing at the cascade, the takeover is now written straight onto
   * the element's style attribute, where it is unconditionally authoritative.
   *
   * The takeover makes the host transparent (and drops the del's
   * strike-through); the visual styling then comes exclusively from OUR
   * spans — `.critic-highlight` egg-yellow for anchors, `.critic-subst-old`
   * red line / `.critic-subst-new` green underline for substitutions.
   *
   * Hosts are found two ways, because neither alone is reliable across
   * Typora's rebuilds:
   *  (a) walking UP from every segment span we own (covers nesting variants a
   *      single `querySelector` misses), and
   *  (b) text-range overlap between a unit and the native element (catches
   *      the shape where our span and the mark are siblings rather than
   *      parent/child, which is what leaves the golden visible).
   *
   * Consumed units are deliberately left to the stylesheet
   * (`.critic-anchor-consumed` egg-yellow / `.critic-consumed-del`): writing
   * the background inline would out-rank `.critic-anchor-reveal`'s
   * `background: transparent !important` and keep the highlight painted while
   * the source is revealed.
   *
   * Every write is paired with a `removeProperty` (see `clearNativeHosts`) so
   * `unwrapAll` / `dispose` restore Typora's native look exactly.
   */
  private neutralizeNativeHosts(block: HTMLElement, units: RevealUnit[]): void {
    const isNative = (el: HTMLElement): boolean => {
      const tag = el.tagName
      return tag === 'MARK' || tag === 'DEL' || tag === 'S' || tag === 'STRIKE'
    }
    const hosts = new Set<HTMLElement>()

    // (a) ancestor walk from our own segments.
    block.querySelectorAll<HTMLElement>('[data-critic-raw-key]').forEach(seg => {
      for (let p = seg.parentElement; p && p !== block; p = p.parentElement) {
        if (isNative(p)) hosts.add(p)
      }
    })

    const natives = Array.from(block.querySelectorAll<HTMLElement>('mark, del, s, strike'))
    // (b) text-range overlap with a unit.
    if (units.length > 0) {
      const ranges = natives.map(el => ({ el, range: textRangeOf(block, el) }))
      for (const u of units) {
        for (const { el, range } of ranges) {
          if (!range) continue
          if (range.from < u.to && range.to > u.from) hosts.add(el)
        }
      }
    }

    for (const el of natives) {
      const owned = el.classList.contains('critic-anchor-consumed')
        || el.classList.contains('critic-consumed-del')
      const host = hosts.has(el) && !owned
      // Keep the class as a documented, CSS-only fallback path.
      el.classList.toggle('critic-native-host', host)
      if (!host) {
        // Never touch a consumed unit or a mark we do not own.
        if (!owned) this.clearNativeHost(el)
        continue
      }
      el.style.setProperty('background-color', 'transparent', 'important')
      el.style.setProperty('color', 'inherit', 'important')
      if (el.tagName !== 'MARK') {
        el.style.setProperty('text-decoration', 'none', 'important')
      }
    }
  }

  /** Undo everything `neutralizeNativeHosts` wrote on one element. */
  private clearNativeHost(el: HTMLElement): void {
    el.classList.remove('critic-native-host')
    el.style.removeProperty('background-color')
    el.style.removeProperty('color')
    el.style.removeProperty('text-decoration')
  }

  /** Undo the takeover across a whole tree (plugin unload / re-render). */
  clearNeutralization(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('mark, del, s, strike').forEach(el => {
      if (el.classList.contains('critic-native-host')
        || el.style.getPropertyValue('background-color')) {
        this.clearNativeHost(el)
      }
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
   * Toggle the raw-source classes (CSS-only). `revealKey` may come straight
   * from a wrapper span (typing inside a unit — the parsed raw has drifted,
   * the wrapper key has not), so it is decoupled from the unit:
   * - `.is-raw` on every segment carrying `revealKey` (chips flatten; the
   *   md-meta `==`/`~~` glyphs inside them are shown by the stylesheet).
   * - consumed units additionally light `.critic-anchor-reveal` /
   *   `.critic-subst-reveal` on their native element.
   * Every other element's reveal state is cleared each pass.
   */
  private syncRawState(block: HTMLElement, revealKey: string | null, revealUnit: RevealUnit | null): void {
    const segs = block.querySelectorAll<HTMLElement>('[data-critic-raw-key]')
    segs.forEach(s => s.classList.toggle('is-raw', !!revealKey && s.dataset.criticRawKey === revealKey))
    block.querySelectorAll<HTMLElement>('.critic-anchor-reveal').forEach(el => {
      if (!revealUnit || revealUnit.kind !== 'consumed-anchor' || revealUnit.el !== el) {
        el.classList.remove('critic-anchor-reveal')
      }
    })
    block.querySelectorAll<HTMLElement>('.critic-subst-reveal').forEach(el => {
      if (!revealUnit || revealUnit.kind !== 'consumed-subst' || revealUnit.el !== el) {
        el.classList.remove('critic-subst-reveal')
      }
    })
    if (revealUnit?.kind === 'consumed-anchor' && revealUnit.el) {
      revealUnit.el.classList.add('critic-anchor-reveal')
    }
    if (revealUnit?.kind === 'consumed-subst' && revealUnit.el) {
      revealUnit.el.classList.add('critic-subst-reveal')
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

    const textSig = (this.acceptedView ? 'A:' : '') + text.length + ':' + hashText(text)
    const expectWraps = tokens.length > 0 || units.some(u => u.kind !== 'token')
    if (block.dataset.criticSig === textSig && this.wrappersMatch(block, expectWraps)) {
      // Fully rendered and current — just make sure no raw reveal lingers
      // (the block may have just lost the caret). Blocks the user typed in
      // while the caret was inside land here too: the full rewrap below
      // refreshes their (stale) wrapper keys the moment the caret leaves.
      this.syncRawState(block, null, null)
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
      } else if (unit.kind === 'consumed-anchor') {
        this.planConsumedAnchorSegments(unit, segments)
      }
    }
    if (segments.length > 0) {
      // Back-to-front so earlier offsets remain valid while we mutate.
      segments
        .slice()
        .sort((a, b) => b.from - a.from)
        .forEach(seg => this.wrapSegment(block, seg))
    }

    this.neutralizeNativeHosts(block, units)
    block.dataset.criticSig = textSig
    this.syncRawState(block, null, null)
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
    delete block.dataset.criticCaret
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

  /**
   * v0.3.2: segments for a consumed anchor's literal `{` / `}`.
   *
   * In the consumed shape those braces are plain text nodes no token owns,
   * so they would stay visible beside the (golden) native mark. Wrapping
   * them in `.critic-mark` hides them in rendered mode and brings them back
   * with `.is-raw`, so revealing the unit still shows the complete
   * `{==text==}`: braces from these spans, `==` synthesized by the
   * stylesheet on the `.critic-anchor-reveal` mark.
   */
  private planConsumedAnchorSegments(unit: RevealUnit, segments: Segment[]): void {
    const mark = segments.length
    segments.push(
      { from: unit.from, to: unit.from + 1, cls: 'critic-mark' },
      { from: unit.to - 1, to: unit.to, cls: 'critic-mark' },
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
