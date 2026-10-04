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
 *
 * v0.4.2 TIMING MODEL (the real cause of the typing flash — measured in
 * Typora 1.14.10's own source, `resources/appsrc/window/frame.js`):
 *
 *   1. `editor.brush` polls every 200ms (`brush.interval = 200`) and every
 *      keystroke / delete pushes the caret block into `brush.queue`
 *      (`h.brush.addToQueue(h.focusCid)`). An IME commit runs
 *      `setTimeout(brushQueue, 10)` on top of that.
 *   2. `brushQueue` renders via `E() -> m()`, which compares the CURRENT
 *      block DOM against freshly generated HTML. Our wrapper spans only
 *      exist in the former, so the two ALWAYS differ and Typora does
 *      `$(block).html(newHtml)` — every wrapper and every `.is-raw` is gone.
 *   3. `brushQueue` is async: it only restores the caret AFTER the render
 *      (`undo.exeCommand(i)`), then calls `brush.expand()`, which ends with
 *      `$(editor.sessionStr).trigger("cursorChange", styleBookmark)`.
 *   4. Our MutationObserver is a MICROTASK: it lands between (2) and (3),
 *      i.e. while the selection is still destroyed by the innerHTML write.
 *      Chromium collapses it to the block start, so `findCaret` returns a
 *      caret at offset 0 (NOT null — which is why v0.4.1's `!caret` branch
 *      never fired). Resolving a unit from offset 0 fails, and the old code
 *      then did `syncRawState(block, null, null)` — clearing `.is-raw` and
 *      painting the badge until the next 150ms selectionchange.
 *
 * Two rules follow, and they are what v0.4.2 implements:
 *   - REPAIR (mutation guard, post-processor pass, compositionend) must
 *     never clear the reveal. It rebuilds wrappers and re-applies the last
 *     known reveal; an untrustworthy caret only makes it fall back.
 *   - The authoritative repair runs at Typora's own `cursorChange`, i.e.
 *     after the render AND after the caret is restored, synchronously in
 *     the same macrotask — so the browser paints one frame, already in
 *     source view. (Typora does the same for `md-expand`, which is exactly
 *     why its own syntax reveal never flashes.)
 *
 * v0.4.3 TRUTH MODEL (the residual "only the caret's own token flashes"):
 * v0.4.2 stopped the WHOLE LINE from flashing, but the single unit under
 * the caret still blinked into a chip on every keystroke / IME commit /
 * delete. The reason is structural, not another timing hole:
 *
 *   1. The reveal lived ONLY as a `.is-raw` class on our wrapper spans,
 *      and those spans are destroyed and rebuilt constantly (Typora's
 *      `$(block).html()` rewrite, our own `unwrapBlock` + rewrap). Every
 *      single pass therefore had to RE-DERIVE "which unit is revealed"
 *      and re-apply the class. Any pass whose derivation came up empty
 *      painted one frame without `.is-raw` — the chip. Every other unit in
 *      the block is never raw anyway, so the symptom is exactly "only the
 *      token the caret sits in blinks".
 *   2. The derivation was keyed on the RAW STRING (`data-critic-raw-key`),
 *      which changes with every character typed. The last remembered key
 *      is therefore stale by construction after an edit, so the fallback
 *      (`blockHasKey(lastRevealKey)`) misses on the freshly rebuilt spans;
 *      `seed = caretOffset >= 0 ? caretOffset : lastCaretOffset` also
 *      preferred the offset-0 artefact over the remembered offset.
 *
 * So v0.4.3 turns the reveal from "a value every pass recomputes" into
 * "persistent state + synchronous projection":
 *
 *   - TRUTH: `block.dataset.criticReveal = <unit ordinal>`. One attribute
 *     on the leaf block, which survives Typora's innerHTML rewrites.
 *   - IDENTITY: the unit's ORDINAL inside the block (`data-critic-unit`),
 *     not its raw string — typing inside a unit never changes its ordinal,
 *     so the reveal cannot drift.
 *   - PROJECTION: `syncReveal(block)` copies the truth onto the spans
 *     (`.is-raw`) and the consumed natives (`.critic-anchor-reveal` /
 *     `.critic-subst-reveal`). Rebuilding wrappers can now NEVER lose the
 *     reveal: every reconstructing pass ends with a projection.
 *   - CLEARING: only an explicit `clearReveal()` may drop the truth, and
 *     it must pass `clearGate()` — editor quiescent (>= QUIET_MS since the
 *     last edit mutation), real user intent, and a second confirming read
 *     (>= CONFIRM_MS apart). Typing / IME / delete all mutate within
 *     200ms, so the quiescence rule alone suppresses every edit-driven
 *     clear; a stale truth is swept by a bounded recheck timer.
 */

const LEAF_BLOCK_SELECTOR = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'dd', 'dt', 'figcaption',
].join(',')

const WRAPPER_SELECTOR = 'span[data-critic-seg]'

/**
 * v0.4.3.1: wrapper SCHEMA version, part of every block signature.
 *
 * v0.4.3 added `data-critic-unit` to the wrapper spans. Blocks wrapped by an
 * older build carry spans WITHOUT it, and their `data-critic-sig` still
 * matches (the text did not change), so every pass hit a fast path and never
 * re-wrapped them — `applyReveal` then found no `[data-critic-unit]` element
 * and could not project the reveal at all. Bump this whenever the attributes
 * the wrappers carry change: it forces exactly one rewrap per block.
 */
const WRAP_SCHEMA = 'v3'

/**
 * v0.4.2: how long after a mutation we still mistrust a caret read of
 * offset 0. Typora's brush rewrites the block and only restores the caret
 * a few microtasks later; 400ms comfortably covers that window while a real
 * "move to block start" gets honoured on the following selectionchange.
 */
const RENDER_SUSPECT_WINDOW = 400

/**
 * v0.4.3: how long the editor must be free of edit mutations before a
 * "the user left the markup" clear is believed. Typora's brush re-renders
 * ~200ms after every edit, so any real editing keeps this rule failing.
 */
const QUIET_MS = 250

/**
 * v0.4.3: a clear needs a SECOND confirming read, at least this far from
 * the first one. Guards against a single bogus caret read landing outside
 * the unit while Typora is rebuilding the line.
 */
const CONFIRM_MS = 120

/**
 * v0.4.3.2: a CROSS-BLOCK leave needs no quiescence and no second read, but a
 * clear landing in the very frame Typora just rewrote the line is still the
 * "chip frame" v0.4.2/v0.4.3 removed. A render suspected within this grace
 * period defers the leave to the bounded sweep (which then clears it ~150ms
 * later, deterministically — no mutations follow a click-away).
 */
const LEAVE_RENDER_GRACE = 120

/**
 * v0.4.3: when a repair must guess which unit was revealed and neither the
 * remembered offset nor the remembered ordinal hits, accept a unit whose
 * range is within this many characters of the remembered caret offset.
 */
const NEAR_TOLERANCE = 12

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
  /**
   * v0.4.3: ordinal of this unit inside its block (index into the sorted
   * `units` array). This — not `key` — is the reveal's identity: it does
   * not change when the user types or deletes inside the unit.
   */
  index: number
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
      index: -1, // assigned by buildRevealUnits after sorting
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
      index: -1, // assigned by buildRevealUnits after sorting
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
      index: -1, // assigned by buildRevealUnits after sorting
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
  // v0.4.3: stamp the ordinal AFTER sorting — it is the stable identity
  // used by `data-critic-unit` and by the block-level reveal truth.
  units.forEach((u, i) => { u.index = i })
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
  /**
   * v0.4.3: the ordinal of the unit currently in source view — the identity
   * that does NOT drift when the user types (unlike `lastRevealKey`).
   */
  private lastRevealOrdinal: number | null = null
  private dirtyBlocks = new Set<HTMLElement>()

  /**
   * v0.4.2: timestamp of the last mutation the guard saw inside the editor.
   * For `RENDER_SUSPECT_WINDOW` after it, a caret read of offset 0 is
   * treated as the "collapsed by an innerHTML rewrite" artefact instead of
   * a genuine move to the block start (see `isCaretTrustworthy`).
   */
  private renderSuspectedAt = 0
  /** v0.4.2: timestamp of the last real user interaction (click / keyup). */
  private userIntentAt = 0

  /**
   * v0.4.3: timestamp of the first "the caret is not in any unit" read that
   * wanted to clear. A clear is only executed on a SECOND read at least
   * `CONFIRM_MS` later (see `clearGate`).
   */
  private pendingMissAt = 0
  /** v0.4.3: bounded self-healing sweep for a reveal the gate refused. */
  private recheckTimer: number | undefined = undefined
  private recheckAttempts = 0

  /** v0.4.2 diagnostics: which hook repaired last, and how it decided. */
  private lastRepairSource = 'none'
  private repairCount = 0
  private keepCount = 0
  private clearCount = 0
  /** v0.4.3: clears the gate refused (this is the good case while typing). */
  private suppressedCount = 0
  /** v0.4.3: ring buffer of reveal decisions, dumped by `debugDump()`. */
  private revealTrace: string[] = []

  private rememberReveal(ordinal: number | null, unit: RevealUnit | null): void {
    this.lastRevealOrdinal = ordinal
    this.lastRevealUnit = unit
    this.lastRevealKey = unit?.key ?? null
  }

  /** v0.4.2: called from the plugin on mousedown / click / keyup. */
  markUserIntent(): void {
    this.userIntentAt = Date.now()
  }

  /** v0.4.2: did the user actually interact within `window` ms? */
  private hasRecentUserIntent(window = 400): boolean {
    return this.userIntentAt > 0 && Date.now() - this.userIntentAt < window
  }

  /**
   * v0.4.2 — the authoritative repair entry point.
   *
   * Called from Typora's own `cursorChange` (jQuery custom event on
   * `#write`), which `brush.expand()` fires at the END of every
   * `brushQueue` tick — i.e. after the block was re-rendered AND after
   * `undo.exeCommand(i)` restored the caret. Repairing here means the
   * browser paints a single frame, already in source view; the MutationObserver
   * (a microtask that lands before the caret is restored) can only ever be a
   * fallback.
   *
   * Semantics: rebuild wrappers, re-apply the last known reveal,
   * NEVER clear `.is-raw`. Scoped to the caret block (+ dirty blocks) —
   * `cursorChange` fires often, so no full-document walk here.
   */
  repairAfterRender(containerEl: HTMLElement): void {
    if (!containerEl || !containerEl.isConnected) return
    // IME: DOM surgery mid-composition duplicates CJK input.
    if (this.composing || this.acceptedView) return
    // Prefer the guard root, but only while it is still the live editor
    // (Typora swaps #write wholesale on a file switch).
    const guard = this.guardRoot
    const root = guard && guard.isConnected ? guard : containerEl
    this.lastRepairSource = 'cursorChange'
    this.repairCount++

    const pending = Array.from(this.dirtyBlocks)
    this.dirtyBlocks.clear()
    const caret = this.findCaret(root)
    const block = caret?.block ?? this.lastCaretBlock
    const allowClear = this.isCaretTrustworthy(caret)
    // v0.4.3: Typora can swap the whole <p>; carry the reveal truth over.
    const prev = this.lastCaretBlock
    if (prev && block && prev !== block && !prev.isConnected) this.adoptReveal(prev, block)

    this.surgery = true
    try {
      for (const b of pending) {
        if (!b.isConnected || !root.contains(b)) continue
        if (caret && b === caret.block) continue
        // v0.4.3: a non-caret block is only re-wrapped and re-projected;
        // it can never "decide" to drop a reveal any more.
        this.processBlock(b)
      }
      if (block && block.isConnected && root.contains(block)) {
        if (caret && block === caret.block) {
          this.processCaretBlock(block, caret.offset, caret.anchorEl, allowClear)
        } else {
          this.processCaretBlock(block, this.lastCaretOffset, null, false)
        }
      }
    } finally {
      this.surgery = false
    }
  }

  /**
   * v0.4.2: can this caret read be believed?
   *
   * A read is untrustworthy when the selection is missing, or when it sits
   * at offset 0 right after Typora rewrote the block (Chromium collapses the
   * selection to the block start when its text node is removed) while we
   * still remember a deeper offset. Treating that artefact as a real caret
   * is precisely what cleared `.is-raw` and painted the badge.
   */
  private isCaretTrustworthy(
    caret: { block: HTMLElement; offset: number } | null,
  ): boolean {
    if (!caret) return false
    if (caret.offset < 0) return false
    if (caret.offset === 0
      && this.lastCaretOffset > 0
      && Date.now() - this.renderSuspectedAt < RENDER_SUSPECT_WINDOW) {
      return false
    }
    return true
  }

  // ------------------------------------------------- v0.4.3 reveal truth

  /**
   * v0.4.3: read the truth — the ordinal of the unit in source view, kept
   * on the LEAF BLOCK (which survives Typora's innerHTML rewrites).
   */
  private readReveal(block: HTMLElement): number | null {
    const raw = block.dataset.criticReveal
    if (raw === undefined || raw === '') return null
    const n = Number(raw)
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  /**
   * v0.4.3: write the truth and project it. Revealing is always allowed —
   * it is never a destructive act (the previous unit's classes go away as a
   * side effect of the projection).
   */
  private setReveal(block: HTMLElement, ordinal: number | null, unit: RevealUnit | null): void {
    if (ordinal == null) return
    this.pendingMissAt = 0
    block.dataset.criticReveal = String(ordinal)
    this.rememberReveal(ordinal, unit)
    this.applyReveal(block, ordinal)
  }

  /**
   * v0.4.3: PROJECTION ONLY — copy the truth onto the DOM.
   *
   * Called at the end of every pass that (re)builds wrappers. It never
   * re-derives and never clears, which is precisely why rebuilding the
   * wrappers can no longer drop the source view.
   */
  private syncReveal(block: HTMLElement): void {
    this.applyReveal(block, this.readReveal(block))
  }

  /** v0.4.3: the ONLY way to drop the truth. Callers must pass `clearGate`. */
  private clearReveal(block: HTMLElement): void {
    this.pendingMissAt = 0
    delete block.dataset.criticReveal
    this.applyReveal(block, null)
  }

  /**
   * v0.4.3: project `ordinal` onto every element carrying a unit ordinal:
   * `.is-raw` on our segments, and the `==` / `~~` synthesis classes on the
   * consumed native elements. Everything else is cleared.
   */
  private applyReveal(block: HTMLElement, ordinal: number | null): void {
    const ord = ordinal == null ? null : String(ordinal)
    block.querySelectorAll<HTMLElement>('[data-critic-unit]').forEach(el => {
      const on = ord !== null && el.dataset.criticUnit === ord
      el.classList.toggle('is-raw', on)
      const tag = el.tagName
      if (tag === 'MARK') {
        el.classList.toggle('critic-anchor-reveal', on)
      } else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
        el.classList.toggle('critic-subst-reveal', on)
      }
    })
  }

  /**
   * v0.4.3: Typora sometimes swaps the whole `<p>`; carry the truth over to
   * the successor element so the replacement does not end the reveal.
   */
  private adoptReveal(from: HTMLElement | null, to: HTMLElement): void {
    if (!from || from === to) return
    const ordinal = this.readReveal(from)
    if (ordinal != null) {
      to.dataset.criticReveal = String(ordinal)
      return
    }
    // Fall back to the remembered ordinal only when the successor really
    // looks like the same paragraph — otherwise a file switch could stamp
    // the reveal onto an unrelated block.
    if (this.lastRevealOrdinal != null && (to.textContent ?? '').includes('{')) {
      to.dataset.criticReveal = String(this.lastRevealOrdinal)
    }
  }

  /**
   * v0.4.3: the clear gate. All three must hold:
   *   1. the editor is QUIESCENT (no edit mutation for `QUIET_MS`) — typing,
   *      IME commits and deletes all mutate inside 200ms, so this alone
   *      suppresses every edit-driven clear;
   *   2. a first miss was already recorded and a second read at least
   *      `CONFIRM_MS` later confirms it;
   *   3. the user really interacted (click / key) recently.
   *
   * @param readOnly v0.4.3: diagnostics only — do NOT arm the first miss.
   * @returns 'ok' = proceed, otherwise the reason it was refused.
   */
  private clearGate(readOnly = false): 'ok' | 'quiet' | 'confirm' | 'intent' {
    if (Date.now() - this.renderSuspectedAt < QUIET_MS) return 'quiet'
    const now = Date.now()
    if (this.pendingMissAt <= 0) {
      if (!readOnly) this.pendingMissAt = now
      return 'confirm'
    }
    if (now - this.pendingMissAt < CONFIRM_MS) return 'confirm'
    if (!this.hasRecentUserIntent()) return 'intent'
    return 'ok'
  }

  /** v0.4.3: bounded self-healing sweep for a truth the gate refused. */
  private scheduleRevealRecheck(): void {
    if (this.recheckTimer !== undefined) return
    this.recheckAttempts = 0
    this.recheckTimer = window.setTimeout(() => this.runRevealRecheck(), CONFIRM_MS + 30)
  }

  private runRevealRecheck(): void {
    this.recheckTimer = undefined
    const root = this.guardRoot
    if (!root || !root.isConnected) return
    const caret = this.findCaret(root)
    let stale = false
    // (a) blocks the caret is NOT in: a leftover reveal there is always stale.
    root.querySelectorAll<HTMLElement>('[data-critic-reveal]').forEach(block => {
      if (block.querySelector(LEAF_BLOCK_SELECTOR)) return
      if (caret && block === caret.block) return
      if (this.clearGate() === 'ok') {
        this.clearReveal(block)
        this.processBlock(block)
      } else {
        stale = true
      }
    })
    // (b) the caret block itself: re-evaluate the unit membership (this sweep
    // exists because a re-evaluation wanted to clear and the gate refused).
    // Skipping it would leave "clicked out of the unit" permanently revealed.
    if (caret && this.readReveal(caret.block) != null) {
      const before = this.readReveal(caret.block)
      this.lastRepairSource = 'recheck'
      this.processCaretBlock(caret.block, caret.offset, caret.anchorEl, true)
      if (this.readReveal(caret.block) === before) stale = true
    }
    if (stale) {
      if (++this.recheckAttempts < 5) {
        this.recheckTimer = window.setTimeout(() => this.runRevealRecheck(), CONFIRM_MS + 30)
      } else {
        // v0.4.3.2: never give up SILENTLY. A stale reveal the sweep stopped
        // chasing then lingered until an unrelated event swept it, which is
        // why the leftover source view looked random. It is now visible in
        // the `TRACE:` line of the debug dump.
        this.traceDecision(this.lastRevealOrdinal, 'giveup')
      }
    }
  }

  /**
   * v0.4.3: the "untrustworthy caret" fallback chain, in ORDINAL space.
   * Only consulted when the caller forbids clearing (every repair path).
   *
   *   1. the unit still containing `lastCaretOffset` (closed interval),
   *   2. the last revealed ordinal, if that unit still exists,
   *   3. the unit nearest to `lastCaretOffset` within `NEAR_TOLERANCE`.
   *
   * Note what is gone: the old `blockHasKey(lastRevealKey)` step compared a
   * STALE raw string against freshly rebuilt spans, so it missed on every
   * edit by construction.
   */
  private resolveRevealKeep(
    block: HTMLElement, units: RevealUnit[],
  ): { ordinal: number | null; unit: RevealUnit | null } {
    const byOffset = this.unitAtOffset(units, this.lastCaretOffset)
    if (byOffset) return { ordinal: byOffset.index, unit: byOffset }
    const remembered = this.lastRevealOrdinal
    if (remembered != null && remembered >= 0 && remembered < units.length) {
      return { ordinal: remembered, unit: units[remembered] }
    }
    const near = this.nearestUnit(units, this.lastCaretOffset, NEAR_TOLERANCE)
    if (near) return { ordinal: near.index, unit: near }
    return { ordinal: null, unit: null }
  }

  /**
   * v0.4.3: single place where a reveal decision is committed.
   *
   * `allowClear === false` marks a REPAIR: a miss runs the fallback chain
   * and, failing that, leaves the truth untouched (suppressed).
   * `allowClear === true` marks a real re-evaluation: a miss may clear, but
   * only through `clearGate()`.
   */
  private commitReveal(
    block: HTMLElement,
    reveal: { ordinal: number | null; unit: RevealUnit | null },
    units: RevealUnit[],
    allowClear: boolean,
  ): void {
    let final = reveal
    if (final.ordinal == null && !allowClear) {
      final = this.resolveRevealKeep(block, units)
    }
    if (final.ordinal != null) {
      this.keepCount++
      this.setReveal(block, final.ordinal, final.unit)
      this.traceDecision(final.ordinal, 'reveal')
      return
    }
    if (allowClear && this.clearGate() === 'ok') {
      this.clearCount++
      this.rememberReveal(null, null)
      this.clearReveal(block)
      this.traceDecision(null, 'clear')
      return
    }
    // Refused: project whatever the truth says (usually "still revealed")
    // so this pass cannot become the "chip frame".
    this.suppressedCount++
    this.syncReveal(block)
    if (allowClear) this.scheduleRevealRecheck()
    this.traceDecision(this.readReveal(block), 'suppress')
  }

  private traceDecision(ordinal: number | null, action: string): void {
    this.revealTrace.push(`${Date.now() % 100000} ${this.lastRepairSource} ${action} #${ordinal ?? '-'}`)
    if (this.revealTrace.length > 40) this.revealTrace.shift()
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
    this.lastRepairSource = 'compositionend'
    this.repairCount++
    const pending = Array.from(this.dirtyBlocks)
    this.dirtyBlocks.clear()
    const caret = this.findCaret(root)
    const block = caret?.block ?? this.lastCaretBlock
    // v0.4.2: a committed character is a REPAIR, never a re-evaluation —
    // clearing here is what made the badge blink once per character.
    const allowClear = false
    this.surgery = true
    try {
      for (const b of pending) {
        if (!b.isConnected || !root.contains(b)) continue
        if (caret && b === caret.block) continue
        this.processBlock(b)
      }
      // The caret block itself may not have produced mutations we recorded
      // (Typora can rebuild it in place), so always re-evaluate it too.
      if (block && block.isConnected && root.contains(block)) {
        if (caret && block === caret.block) {
          this.processCaretBlock(block, caret.offset, caret.anchorEl, allowClear)
        } else {
          this.processCaretBlock(block, this.lastCaretOffset, null, allowClear)
        }
      }
    } finally {
      this.surgery = false
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
    // v0.4.2: the framework runs this ~400ms after every edit, which can
    // land while the caret is still the collapsed artefact of Typora's
    // innerHTML rewrite. Routing the remembered caret block through
    // `processBlock` there clears `.is-raw` — the badge flash.
    const trusted = this.isCaretTrustworthy(caret)

    const blocks = containerEl.querySelectorAll<HTMLElement>(LEAF_BLOCK_SELECTOR)
    blocks.forEach(block => {
      // Only leaves are processed (skip containers with nested blocks).
      if (block.querySelector(LEAF_BLOCK_SELECTOR)) return
      if (caret && block === caret.block) {
        this.processCaretBlock(block, caret.offset, caret.anchorEl, trusted)
      } else if (!trusted && block === this.lastCaretBlock) {
        this.processCaretBlock(block, this.lastCaretOffset, null, false)
      } else {
        // v0.4.3: a reveal left over on a block the caret is not in is
        // swept here, but only through the gate — never unconditionally
        // (an unconditional sweep was one of the "chip frame" sources).
        if (this.readReveal(block) != null) {
          if (this.clearGate() === 'ok') this.clearReveal(block)
          else this.scheduleRevealRecheck()
        }
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
      // v0.4.1 focus guard: an unreadable caret is NOT proof the user left
      // the editor. This handler runs on a 150ms-debounced selectionchange,
      // which can land inside Typora's own surgery window (brush removes and
      // re-adds the selection ranges while rebuilding the line). Clearing
      // the reveal then is exactly the "badge flashes, then source comes
      // back" symptom. Only treat it as "left the editor" when the FOCUS
      // really moved out (panel textarea, modal input, another window);
      // while #write / content / body still holds focus, keep the current
      // state and let the next selectionchange re-evaluate.
      const active = document.activeElement
      const focusInside = active === containerEl
        || (active instanceof Node && containerEl.contains(active))
        || active === document.body
        || active === null
      if (focusInside) return
      // Caret left the editor (panel / modal / elsewhere): re-wrap the
      // block that was showing raw markup, if any.
      const prev = this.lastCaretBlock
      if (prev && prev.isConnected && containerEl.contains(prev)) {
        // v0.4.3.1: focus loss is GATED as well — no longer an unconditional
        // clear. Our own "Debug: Dump …" command is a GLOBAL command, so
        // invoking it (from the command palette) steals focus; an ungated
        // clear destroyed the very state the dump is supposed to show, which
        // is exactly why every dump read `lastCaretOffset=-1, revealKey=null`.
        // A transient focus loss is swept by the bounded recheck instead.
        if (this.clearGate() === 'ok') {
          this.clearReveal(prev)
          this.processBlock(prev)
          this.lastCaretBlock = null
          this.lastCaretOffset = -1
          this.rememberReveal(null, null)
        } else {
          this.scheduleRevealRecheck()
          this.processBlock(prev)
        }
      } else {
        this.lastCaretBlock = null
        this.lastCaretOffset = -1
        this.rememberReveal(null, null)
      }
      return
    }
    this.lastRepairSource = 'caretMove'
    const trusted = this.isCaretTrustworthy(caret)
    // v0.4.2: only a *deliberate* move may end a reveal — a click or a key
    // (see markUserIntent), or a jump to another block. An untrustworthy
    // read (selection collapsed by Typora's rewrite) must keep it.
    const allowClear = trusted
      && (this.hasRecentUserIntent() || caret.block !== this.lastCaretBlock)
    // Never remember the offset-0 artefact: it would poison every later
    // fallback that replays `lastCaretOffset` (resolveRevealKeep).
    if (trusted) this.lastCaretOffset = caret.offset
    if (caret.block === this.lastCaretBlock) {
      // Same block — unit membership may still differ; re-evaluate.
      this.processCaretBlock(caret.block, caret.offset, caret.anchorEl, allowClear)
      return
    }
    const prev = this.lastCaretBlock
    if (prev && prev.isConnected && containerEl.contains(prev)) {
      // v0.4.3.2: moving to another block IS the leave, and a TRUSTED read
      // in another block cannot be Typora's artefact — its re-renders only
      // collapse the selection INSIDE the line being rebuilt, and that
      // offset-0 case is already filtered by `isCaretTrustworthy`. Waiting
      // on `clearGate` here (250ms quiescence + 120ms confirmation, both
      // endlessly renewed by the typing that preceded the click, plus a
      // recheck sweep that gave up after 5 attempts) is what left the block
      // in source view for 150–800ms or forever — the "it re-renders
      // sometimes, I can't find the trigger" report.
      //
      // The gate keeps guarding the SAME-BLOCK case (see `commitReveal`),
      // which is where every edit-driven bogus read lives; that is the
      // anti-flash guarantee of v0.4.2/v0.4.3 and it is untouched here.
      // The only thing still checked: a render suspected within
      // LEAVE_RENDER_GRACE defers the leave to the bounded sweep instead of
      // clearing inside Typora's own rewrite frame.
      if (allowClear && Date.now() - this.renderSuspectedAt >= LEAVE_RENDER_GRACE) {
        this.clearReveal(prev)
      } else if (allowClear) {
        this.scheduleRevealRecheck()
      }
      this.processBlock(prev)
    }
    this.processCaretBlock(caret.block, caret.offset, caret.anchorEl, allowClear)
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
    // v0.4.3: the TRUTH on the block element vs. the remembered ordinal —
    // they must agree; a chip flash means the truth was dropped somewhere.
    out.push(`revealAttr=${JSON.stringify(block.dataset.criticReveal ?? null)}  lastRevealOrdinal=${this.lastRevealOrdinal}`)
    // v0.4.3.1: wrapper health. `unitSpans` MUST equal the number of
    // revealed segments — 0 means the spans were wrapped by an older build
    // (see WRAP_SCHEMA) and the reveal can never be projected onto them.
    out.push([
      `schema=${WRAP_SCHEMA}`,
      `sig=${block.dataset.criticSig ?? '-'}`,
      `unitSpans=${block.querySelectorAll('[data-critic-unit]').length}`,
      `rawSpans=${block.querySelectorAll('[data-critic-raw-key]').length}`,
    ].join('  '))
    // v0.4.3.1: what the CURRENT caret resolves to, computed but NOT
    // committed — the dump stays meaningful even after the debug command's
    // own focus loss (it is a global command and steals focus).
    const text = block.textContent ?? ''
    const tokens = text.includes('{')
      ? parser.parseTokens(text, { mergeAnchored: false })
      : []
    const units = buildRevealUnits(block, text, tokens)
    const now = this.resolveReveal(block, caret ? caret.offset : -1, caret?.anchorEl ?? null, units)
    out.push(`resolveNow ordinal=${now.ordinal ?? '-'}  units=${units.length}  range=${now.unit ? `[${now.unit.from},${now.unit.to}]` : '-'}`)
    // v0.4.2: which hook repaired last, and whether it kept or cleared the
    // reveal. A healthy editing session shows a keep tide with no clears
    // coming from `guard` / `cursorChange` while typing.
    out.push([
      `repairSource=${this.lastRepairSource}`,
      `repairs=${this.repairCount}`,
      `kept=${this.keepCount}`,
      `cleared=${this.clearCount}`,
      `suppressed=${this.suppressedCount}`,
      `gate=${this.clearGate(true)}`,
      `caretTrusted=${this.isCaretTrustworthy(caret)}`,
      `renderSuspectAge=${Date.now() - this.renderSuspectedAt}ms`,
      `userIntentAge=${this.userIntentAt ? Date.now() - this.userIntentAt : -1}ms`,
    ].join('  '))
    // v0.4.3: the last decisions — "suppress" entries while typing are the
    // proof that the gate (not luck) is keeping the source view alive.
    out.push('TRACE: ' + this.revealTrace.slice(-12).join(' | '))
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
      // v0.4.3: the reveal truth lives on the block — drop it too, or the
      // plugin would leave a marker permanently in source view.
      delete block.dataset.criticReveal
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
    // v0.4.3: stop the bounded recheck sweep.
    if (this.recheckTimer !== undefined) {
      window.clearTimeout(this.recheckTimer)
      this.recheckTimer = undefined
    }
  }

  dispose(): void {
    this.detachMutationGuard()
    this.lastCaretBlock = null
    this.lastCaretOffset = -1
    this.rememberReveal(null, null)
    this.pendingMissAt = 0
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
    // v0.4.2: any mutation inside the editor opens the window in which a
    // caret read of offset 0 is mistrusted (Typora rewrites the block and
    // only restores the caret a few microtasks later).
    //
    // v0.4.3: only EDIT-relevant blocks move the timestamp. Typora has
    // always-running decorative mutations (caret, focus outlines, …) and if
    // those fed `renderSuspectedAt` the v0.4.3 quiescence rule would never
    // let a clear through.
    const isEditingNoise = (block: HTMLElement): boolean =>
      block === this.lastCaretBlock
      || block.dataset.criticReveal !== undefined
      || block.querySelector(WRAPPER_SELECTOR) !== null
      || (block.textContent ?? '').includes('{')
    if (Array.from(blocks).some(isEditingNoise)) this.renderSuspectedAt = Date.now()
    this.lastRepairSource = 'guard'
    this.repairCount++

    // IME composition: never run DOM surgery mid-composition — swapping
    // text nodes under the caret is what duplicated CJK input before.
    // v0.4.0: remember the blocks instead of dropping them, so the repair
    // happens in the compositionend frame (same frame, no painted flash).
    if (this.composing) {
      const prev = this.lastCaretBlock
      for (const block of blocks) {
        this.dirtyBlocks.add(block)
        // v0.4.3: even without surgery we can carry the truth over when
        // Typora swapped the <p> mid-composition.
        if (prev && !prev.isConnected && blocks.size === 1) this.adoptReveal(prev, block)
      }
      return
    }

    const caret = this.findCaret(root)
    // v0.4.2 — THE fix. The guard is a MICROTASK: it runs right after
    // Typora's `$(block).html(newHtml)` but BEFORE `undo.exeCommand(i)`
    // restores the caret. The selection is therefore still the artefact of
    // the innerHTML rewrite — usually a valid range collapsed at offset 0,
    // which v0.4.1 happily believed and turned into "no unit at caret" →
    // `syncRawState(null)` → badge, until the next selectionchange.
    const trusted = this.isCaretTrustworthy(caret)
    // v0.4.1: Typora can replace the whole <p> while rebuilding a line, so
    // lastCaretBlock may point at a DETACHED element while the live caret
    // block is the freshly inserted one. Adopt the single rebuilt block then.
    const prevUsable = !!this.lastCaretBlock
      && this.lastCaretBlock.isConnected
      && root.contains(this.lastCaretBlock)
    let adopted = false
    this.surgery = true
    try {
      for (const block of blocks) {
        if (caret && block === caret.block) {
          this.processCaretBlock(block, caret.offset, caret.anchorEl, trusted)
        } else if (!trusted && (block === this.lastCaretBlock
          || (!prevUsable && !adopted && blocks.size === 1))) {
          // Caret unreadable / collapsed: keep the block in caret mode with
          // the last known offset and repair only (`allowClear: false`).
          // v0.4.3: Typora may have swapped the <p> — carry the reveal truth
          // over to the rebuilt element before re-processing it.
          adopted = true
          this.adoptReveal(this.lastCaretBlock, block)
          this.processCaretBlock(block, this.lastCaretOffset, null, false)
        } else {
          // v0.4.3: never passes a "may clear" flag any more — a repair pass
          // can only re-wrap and project.
          this.processBlock(block)
        }
      }
    } finally {
      this.surgery = false
    }
  }

  /**
   * @param allowClear v0.4.2 — `false` marks a REPAIR (mutation guard,
   * compositionend, post-render hook): the reveal may be refreshed but never
   * dropped. `true` marks a real re-evaluation (user moved the caret).
   */
  private processCaretBlock(
    block: HTMLElement, caretOffset: number, anchorEl: HTMLElement | null,
    allowClear = true,
  ): void {
    this.lastCaretBlock = block
    // Only a trustworthy offset may overwrite the remembered one — the
    // offset-0 artefact would poison every later fallback replay.
    if (caretOffset > 0 || (caretOffset >= 0 && this.lastCaretOffset < 0)) {
      this.lastCaretOffset = caretOffset
    }
    const text = block.textContent ?? ''
    const tokens = text.includes('{')
      ? parser.parseTokens(text, { mergeAnchored: false })
      : []
    const units = buildRevealUnits(block, text, tokens)
    this.syncConsumedClasses(block, units)

    const reveal = this.resolveReveal(block, caretOffset, anchorEl, units)

    const textSig = WRAP_SCHEMA + ':' + (this.acceptedView ? 'A:' : '') + text.length + ':' + hashText(text)
    const caretSig = WRAP_SCHEMA + ':' + (this.acceptedView ? 'A:' : '') + 'C:' + units.length
    const expectWraps = tokens.length > 0 || units.some(u => u.kind !== 'token')

    // Fast path A — caret stamp current (typing inside a unit): keep the
    // spans, only sync the reveal classes.
    if (block.dataset.criticCaret === caretSig && this.wrappersMatch(block, expectWraps)) {
      this.commitReveal(block, reveal, units, allowClear)
      return
    }
    // Fast path B — text unchanged since the last full wrap: just stamp
    // the caret format. Entering caret mode must NOT rewrap, or the FIRST
    // keystroke after a click would destroy the composition session.
    if (block.dataset.criticSig === textSig && this.wrappersMatch(block, expectWraps)) {
      block.dataset.criticCaret = caretSig
      this.commitReveal(block, reveal, units, allowClear)
      return
    }

    // Full rewrap (unit count changed, or Typora rebuilt the block). The
    // surgery destroys text nodes — restore the caret to its exact offset
    // afterwards, or the browser flings it to the block start.
    this.unwrapBlock(block)
    const segments: Segment[] = []
    for (const token of tokens) {
      this.planToken(token, segments, units)
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
    // v0.4.3: re-stamp the unit ordinals (wrapping clones / re-parents the
    // native elements) before the reveal is projected.
    this.syncConsumedClasses(block, units)
    // v0.4.0: the native mark/del hosting our spans is neutralized by inline
    // !important (CSS alone proved unreliable) — recomputed after every wrap.
    this.neutralizeNativeHosts(block, units)

    // v0.4.0 — THE typing-flash fix, part 1.
    // `reveal` was resolved BEFORE the surgery, i.e. off the pre-surgery
    // wrapper span, whose data-critic-raw-key is the raw markup WITHOUT the
    // character the user just typed. The spans we just created carry the NEW
    // key, so syncRawState(reveal.key) matched nothing and the frame painted
    // the RENDERED view; the source view only came back on the next
    // selectionchange (150ms debounce) — one flash per keystroke.
    // Re-locate the caret in the POST-surgery DOM and resolve again: the
    // anchor now sits inside a fresh wrapper carrying the new key (`findCaret`
    // is read-only, so the caret itself is untouched).
    //
    // v0.4.1 — part 2, the ACTUAL flash the user still saw.
    // Typora's brush rebuilds the line ~200ms after each edit from a 200ms
    // setTimeout, and its brushQueue is async: it saves the selection, does
    // the DOM surgery inside `await`ed calls, and only restores the selection
    // (exeCommand) AFTER the awaits. Our guard therefore runs in exactly that
    // window with the selection hanging on a DETACHED node — findCaret returns
    // null, and v0.4.0's `: { key: null, unit: null }` fallback CLEARED
    // .is-raw right there: the badge rendered until the next 150ms
    // selectionchange brought the source back. That was the per-keystroke
    // "flashes into a badge, then back to source".
    //
    // Rule now (v0.4.2): an untrustworthy caret must never clear the reveal.
    // Only a caret that is trustworthy AND resolves outside every unit does.
    //
    // v0.4.3: the resolution moved to ORDINAL space and the renewal chain
    // moved into `commitReveal` / `resolveRevealKeep`. Two concrete bugs die
    // with it: (a) the chain used to be seeded with `caretOffset`, i.e. with
    // the offset-0 artefact instead of `lastCaretOffset`; (b) its second
    // step compared the LAST REMEMBERED RAW STRING against freshly rebuilt
    // spans, which by construction misses after every edit.
    const post = this.findCaret(block)
    let final = post
      ? this.resolveReveal(block, post.offset, post.anchorEl, units)
      : { ordinal: null, unit: null }
    if (final.ordinal == null && !post) {
      // No readable caret at all (Typora's rewrite destroyed the selection):
      // continue the unit the caret was already in.
      final = this.resolveRevealKeep(block, units)
    }
    this.commitReveal(block, final, units, allowClear)
  }

  /**
   * Generous closed-interval variant of `revealUnitForCaret`: any offset in
   * [u.from, u.to] hits (no margin shrink). Only used on the renewal chain,
   * where the offset may be one character stale and the alternative — falling
   * to the rendered view — is exactly the bug being fixed.
   */
  private unitAtOffset(units: RevealUnit[], offset: number): RevealUnit | null {
    if (offset < 0) return null
    for (const u of units) {
      if (offset >= u.from && offset <= u.to) return u
    }
    return null
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
  ): { ordinal: number | null; unit: RevealUnit | null } {
    if (anchorEl) {
      // v0.4.3: identity is the ORDINAL stamped on the span, not its raw
      // string — the raw drifts while typing, the ordinal does not.
      const marked = anchorEl.closest<HTMLElement>('[data-critic-unit]')
      if (marked && block.contains(marked)) {
        const n = Number(marked.dataset.criticUnit)
        if (Number.isInteger(n)) {
          const byOrdinal = units.find(u => u.index === n)
          if (byOrdinal) return { ordinal: n, unit: byOrdinal }
        }
      }
      const wrapper = anchorEl.closest<HTMLElement>('[data-critic-raw-key]')
      if (wrapper && block.contains(wrapper)) {
        const key = wrapper.dataset.criticRawKey ?? ''
        const byKey = key ? units.find(u => u.key === key) : undefined
        if (byKey) return { ordinal: byKey.index, unit: byKey }
      }
    }
    const byOffset = this.revealUnitForCaret(units, caretOffset)
    if (byOffset) return { ordinal: byOffset.index, unit: byOffset }
    if (anchorEl) {
      const byEl = units.find(u => u.kind !== 'token' && u.el && u.el.contains(anchorEl))
      if (byEl) return { ordinal: byEl.index, unit: byEl }
    }
    return { ordinal: null, unit: null }
  }

  /**
   * v0.4.3: the unit whose range is closest to `offset`, if within
   * `tolerance`. Last resort of the repair fallback chain — it can only fire
   * while clearing is forbidden, so a slightly generous match is safer than
   * dropping the source view.
   */
  private nearestUnit(units: RevealUnit[], offset: number, tolerance: number): RevealUnit | null {
    if (offset < 0) return null
    let best: RevealUnit | null = null
    let bestDist = Infinity
    for (const u of units) {
      const dist = offset < u.from ? u.from - offset : offset > u.to ? offset - u.to : 0
      if (dist < bestDist) {
        bestDist = dist
        best = u
      }
    }
    return best && bestDist <= tolerance ? best : null
  }

  /** Cosmetic classes on the native consumed elements (idempotent). */
  private syncConsumedClasses(block: HTMLElement, units: RevealUnit[]): void {
    block.querySelectorAll<HTMLElement>('mark').forEach(mark => {
      const unit = units.find(u => u.kind === 'consumed-anchor' && u.el === mark)
      mark.classList.toggle('critic-anchor-consumed', !!unit && !this.acceptedView)
      // v0.4.3: the native element carries the unit's ordinal too, so the
      // reveal projection (and the CSS ordinal safety net) can target the
      // `==` / `~~` synthesis without re-deriving it from the text.
      if (unit) mark.dataset.criticUnit = String(unit.index)
      else delete mark.dataset.criticUnit
    })
    block.querySelectorAll<HTMLElement>('del, s, strike').forEach(del => {
      const unit = units.find(u => u.kind === 'consumed-subst' && u.el === del)
      del.classList.toggle('critic-consumed-del', !!unit)
      if (unit) del.dataset.criticUnit = String(unit.index)
      else delete del.dataset.criticUnit
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
    // v0.4.3: never restore an offset we do not believe — the offset-0
    // artefact of Typora's innerHTML rewrite would fling the caret to the
    // block start (Typora restores the real caret itself a moment later).
    if (!this.isCaretTrustworthy({ block, offset })) return
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

  private wrappersMatch(block: HTMLElement, expected: boolean): boolean {
    return (block.querySelector(WRAPPER_SELECTOR) !== null) === expected
  }

  /**
   * v0.4.3: re-wrap a block WITHOUT the caret. The reveal is no longer a
   * parameter: this method can only PROJECT the block's truth (`syncReveal`),
   * never clear it — dropping a reveal is `clearReveal()` behind `clearGate`.
   */
  private processBlock(block: HTMLElement): void {
    const text = block.textContent ?? ''
    const tokens = text.includes('{')
      ? parser.parseTokens(text, { mergeAnchored: false })
      : []
    const units = buildRevealUnits(block, text, tokens)
    this.syncConsumedClasses(block, units)

    const textSig = WRAP_SCHEMA + ':' + (this.acceptedView ? 'A:' : '') + text.length + ':' + hashText(text)
    const expectWraps = tokens.length > 0 || units.some(u => u.kind !== 'token')
    if (block.dataset.criticSig === textSig && this.wrappersMatch(block, expectWraps)) {
      // Fully rendered and current — just re-project the truth. Blocks the
      // user typed in while the caret was inside land here too: the full
      // rewrap below refreshes their (stale) wrapper keys.
      this.syncReveal(block)
      return
    }

    this.unwrapBlock(block)

    const segments: Segment[] = []
    for (const token of tokens) {
      this.planToken(token, segments, units)
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

    // v0.4.3: re-stamp the unit ordinals on the native elements — wrapping
    // can clone / re-parent them, and the projection keys off `data-critic-unit`.
    this.syncConsumedClasses(block, units)
    this.neutralizeNativeHosts(block, units)
    block.dataset.criticSig = textSig
    this.syncReveal(block)
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

  private planToken(token: CriticToken, segments: Segment[], units: RevealUnit[]): void {
    const { acceptedView } = this
    const mark = segments.length
    // v0.4.3: the token's reveal identity is its ordinal, resolved by
    // token identity (buildRevealUnits keeps the same token objects).
    const unitIndex = units.find(u => u.kind === 'token' && u.token === token)?.index ?? -1
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
      s.attrs = {
        ...(s.attrs ?? {}),
        'data-critic-raw-key': token.raw,
        ...(unitIndex >= 0 ? { 'data-critic-unit': String(unitIndex) } : {}),
      }
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
      s.attrs = {
        ...(s.attrs ?? {}),
        'data-critic-raw-key': unit.key,
        'data-critic-unit': String(unit.index),
      }
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
      s.attrs = {
        ...(s.attrs ?? {}),
        'data-critic-raw-key': unit.key,
        'data-critic-unit': String(unit.index),
      }
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
