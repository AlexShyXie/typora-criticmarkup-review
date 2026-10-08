import './style.scss'

import { Plugin, PluginSettings } from '@typora-community-plugin/core'
import { editor } from 'typora'

import { DEFAULT_REVIEW_SETTINGS, type ReviewSettings } from './settings/model'
import { ReviewSettingsTab } from './settings/settings-tab'
import { ReviewController } from './actions/review-controller'
import { replaceSelectionWith } from './actions/writeback'
import { promptText, captureEditableRange, restoreEditableRange } from './actions/comment-modal'
import { CriticRenderService, findCursorTarget } from './render/critic-processor'
import { RightDockPlacement } from './placement/right-dock'
import {
  ReviewView,
  REVIEW_VIEW_TYPE,
  type QuickActionType,
} from './panel/review-view'
import {
  buildAddition,
  buildDeletion,
  buildHighlight,
  buildSubstitution,
} from './critic/markup'
import {
  buildAnchoredCommentMarkup,
  buildStandaloneCommentMarkup,
} from './critic/thread'
import { acceptAll } from './critic/resolve'

export default class CriticReviewPlugin extends Plugin<ReviewSettings> {

  private controller!: ReviewController
  private renderService!: CriticRenderService
  private placement!: RightDockPlacement
  private refreshTimer: number | undefined
  /** v0.4.2 disposer for the Typora `cursorChange` hook (see below). */
  private detachCursorChange: (() => void) | null = null

  onload() {
    const settings = new PluginSettings<ReviewSettings>(this.app, this.manifest, { version: 1 })
    settings.setDefault(DEFAULT_REVIEW_SETTINGS)
    this.registerSettings(settings)

    this.controller = new ReviewController(this.app, this.settings)
    this.renderService = new CriticRenderService()
    // Write-backs settle early (park caret + direct re-render) instead of
    // waiting for the framework's ~400ms observer round-trip.
    this.controller.setAfterWrite(() => this.renderService.process(editor.writingArea))

    // v0.3.2 same-frame repair: Typora re-renders a line's inline DOM on
    // SPACE (dropping our wrapper spans) while the framework only re-runs
    // post-processors after ~400ms, which painted raw source for that long.
    // The guard repairs in the mutation microtask, i.e. before paint.
    const attachGuard = () => {
      this.renderService.attachMutationGuard(editor.writingArea)
      // v0.4.4: clicking a comment / reply badge parks the caret at the
      // comment's body start and reveals its source (the badge itself is
      // zero-width + user-select:none, so the browser cannot do it), then
      // flashes the matching card in the review panel.
      this.renderService.attachPointerFocus(editor.writingArea, navKey => {
        this.placement.getView<ReviewView>()?.highlightByNavKey(navKey)
      })
      // v0.4.2: the authoritative repair hook (see attachCursorChangeHook).
      this.detachCursorChange?.()
      this.detachCursorChange = this.attachCursorChangeHook()
    }
    if (editor.writingArea) attachGuard()
    else setTimeout(attachGuard, 300)
    this.register(() => this.detachCursorChange?.())

    // v0.4.2: only a deliberate click / keypress may END a reveal. Typora's
    // own caret restoration (undo.exeCommand) and our DOM surgery also emit
    // selectionchange, and those must never be read as "the user left".
    const intentHandler = () => this.renderService.markUserIntent()
    const intentEvents: Array<keyof DocumentEventMap> = ['mousedown', 'click', 'keyup']
    intentEvents.forEach(type => document.addEventListener(type, intentHandler, true))
    this.register(() => {
      intentEvents.forEach(type => document.removeEventListener(type, intentHandler, true))
    })

    // Editor / preview rendering through the framework post-processor.
    // NOTE: the framework itself re-runs our processor on every 'edit'
    // (bindPostProcessorToEditor -> processAll), so this handler only
    // refreshes the panel — calling renderService.process() here again
    // would double every mutation and feed the observer loop.
    const mdEditor = this.app.features.markdownEditor
    this.register(
      mdEditor.postProcessor.register(this.renderService.buildProcessor()),
    )
    this.register(mdEditor.on('edit', () => this.schedulePanelRefresh()))

    // Typora lazy-renders blocks while scrolling: catch new blocks.
    let scrollTimer: number | undefined
    this.register(mdEditor.on('scroll', () => {
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        this.renderService.process(editor.writingArea)
      }, 200)
    }))
    this.register(() => window.clearTimeout(scrollTimer))

    // Caret moves between blocks: the token containing the caret shows raw
    // markup (Typora-native behavior for inline syntax), the rest stays
    // rendered. Debounced; only acts when the caret block changed.
    let caretTimer: number | undefined
    const selectionHandler = () => {
      window.clearTimeout(caretTimer)
      caretTimer = window.setTimeout(() => {
        this.renderService.handleCaretMove(editor.writingArea)
      }, 150)
    }
    document.addEventListener('selectionchange', selectionHandler)
    this.register(() => {
      document.removeEventListener('selectionchange', selectionHandler)
      window.clearTimeout(caretTimer)
    })

    // Right-dock panel.
    this.register(
      this.app.viewManager.registerView(REVIEW_VIEW_TYPE, (leaf) => {
        const view = new ReviewView(leaf, {
          onQuickAction: a => this.runQuickAction(a),
          onAcceptChange: e => this.controller.acceptChange(e),
          onRejectChange: e => this.controller.rejectChange(e),
          onNavigateChange: e => this.controller.navigateChange(e),
          onNavigateComment: (e, replyIndex) => this.controller.navigateComment(e, replyIndex),
          // v0.4.5: a freshly mounted view starts with the empty default
          // dataset — give it a real scan instead of waiting for an edit.
          onPanelOpened: () => this.controller.refreshPanel(),
          onEditComment: (e, body, tag) => this.controller.editComment(e, body, tag),
          onReplyComment: (e, body) => this.controller.replyComment(e, body),
          onEditReply: (e, index, body) => this.controller.editReply(e, index, body),
          onResolveComment: e => this.controller.resolveComment(e),
          onToggleAcceptedView: () => this.toggleAcceptedView(),
          onAcceptAll: () => this.controller.acceptAll(),
          onRefreshPanel: () => {
            this.renderService.process(editor.writingArea)
            this.controller.refreshPanel()
          },
        })
        this.controller.attachPanel(view)
        return view
      }),
    )
    this.placement = new RightDockPlacement(this.app)

    this.registerCommands()

    const settingsTab = new ReviewSettingsTab(this)
    this.registerSettingTab(settingsTab)
    this.register(() => settingsTab.onhide())
    this.register(this.settings.onChange('*', (key) => {
      if (key === 'acceptedViewEnabled') {
        const next = this.settings.get('acceptedViewEnabled') === true
        this.renderService.acceptedView = next
        this.renderService.unwrapAll(editor.writingArea)
        this.renderService.process(editor.writingArea)
        this.controller.refreshPanel()
      }
    }))

    if (this.settings.get('autoOpenPanel')) this.placement.open()
    this.refreshReviewPanel(300)
  }

  onunload() {
    // Detach the guard FIRST: unwrapAll removes our wrapper spans and the
    // mutation guard would otherwise re-wrap them right back.
    this.renderService?.dispose()
    this.renderService?.unwrapAll(editor.writingArea)
    this.controller?.detachPanel()
    this.placement?.dispose()
    window.clearTimeout(this.refreshTimer)
  }

  // ------------------------------------------------------------- commands

  private registerCommands() {
    const cmd = (
      id: string, title: string, callback: () => void,
      scope: 'editor' | 'global' = 'editor',
    ) => this.registerCommand({ id, title, scope, callback })

    cmd('mark-addition', 'Mark Selection as Addition', () => this.wrapSelection('addition'))
    cmd('mark-deletion', 'Mark Selection as Deletion', () => this.wrapSelection('deletion'))
    cmd('mark-highlight', 'Mark Selection as Highlight', () => this.wrapSelection('highlight'))
    cmd('mark-substitution', 'Mark Selection as Replace', () => this.promptSubstitution())
    cmd('comment-selection', 'Comment on Selection', () => this.insertCommentFromSelection())
    cmd('strip-at-cursor', 'Strip CriticMarkup Markup at Cursor', () => this.stripAtCursor())

    cmd('accept-change-at-cursor', 'Accept Change at Cursor', () => this.resolveAtCursor(true))
    cmd('reject-change-at-cursor', 'Reject Change at Cursor', () => this.resolveAtCursor(false))
    cmd('accept-all-changes', 'Accept All Changes', () => {
      this.controller.acceptAll()
    })
    cmd('copy-clean-text', 'Copy Clean Text (All Accepted)', () => this.copyCleanText())
    cmd('toggle-accepted-view', 'Toggle Accepted View', () => this.toggleAcceptedView())
    cmd('toggle-review-panel', 'Toggle Review Panel', () => {
      this.placement.toggle()
      // v0.4.5: panel entries are only rebuilt on document edits, so a panel
      // opened (or re-expanded) by this command showed a stale — or empty —
      // list until the user hit Refresh. Refresh whenever it ended up
      // visible; the late second pass covers the leaf the command may have
      // just created asynchronously.
      if (this.placement.isVisible()) this.refreshReviewPanel(60)
      setTimeout(() => {
        if (this.placement.isVisible()) this.refreshReviewPanel(0)
      }, 400)
    }, 'global')
    // v0.4.6: "Debug: Dump Block DOM at Cursor" was removed from the palette.
    // The plumbing it used (`dumpBlockDom()` below and
    // `CriticProcessor.debugDump()`) is deliberately kept — re-registering this
    // one line brings the diagnostic back whenever it is needed again.
    cmd('refresh-review', 'Refresh Review Panel', () => this.refreshReviewPanel(0), 'global')
  }

  private runQuickAction(action: QuickActionType): void {
    switch (action) {
      case 'add': return this.wrapSelection('addition')
      case 'delete': return this.wrapSelection('deletion')
      case 'highlight': return this.wrapSelection('highlight')
      case 'replace': return this.promptSubstitution()
      case 'comment': return this.insertCommentFromSelection()
      case 'strip':
        return this.stripAtCursor()
    }
  }

  // ------------------------------------------------------------ selection

  private getSelectionText(): string | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const text = sel.toString()
    return text ? text : null
  }

  private wrapSelection(kind: 'addition' | 'deletion' | 'highlight'): void {
    const selection = this.getSelectionText()
    if (!selection) {
      editor.EditHelper.showNotification('CriticMarkup: select some text first')
      return
    }
    const markup =
      kind === 'addition' ? buildAddition(selection)
        : kind === 'deletion' ? buildDeletion(selection)
          : buildHighlight(selection)
    replaceSelectionWith(editor, markup)
    this.schedulePanelRefresh()
  }

  private promptSubstitution(): void {
    const selection = this.getSelectionText()
    if (!selection) {
      editor.EditHelper.showNotification('CriticMarkup: select some text first')
      return
    }
    // The modal focuses its input ~30ms after opening, which empties the
    // document selection — capture the range first and restore it before
    // writing, or the paste pipeline has nothing to replace (v0.3.1).
    const savedRange = captureEditableRange()
    promptText({
      title: `Replace: ${selection.slice(0, 60)}${selection.length > 60 ? '…' : ''}`,
      placeholder: 'Replacement text…',
      confirmLabel: 'Replace',
      onConfirm: (newText) => {
        restoreEditableRange(savedRange)
        replaceSelectionWith(editor, buildSubstitution(selection, newText))
        this.schedulePanelRefresh()
      },
    })
  }

  private insertCommentFromSelection(): void {
    const selection = this.getSelectionText()
    const author = this.settings.get('authorName')
    const tag = this.settings.get('defaultTypeTag')

    let markup: string
    let navKey: string
    if (selection) {
      // Anchored: `{==selection==}{>>Hui|NOTE: <<}` (unchanged design).
      markup = buildAnchoredCommentMarkup(selection, author, tag, '')
      navKey = markup.slice(selection.length + 6) // comment part only
    } else {
      // Anchorless note at the caret: `{>>rc-xxxxxx|Hui|2026-10-08|NOTE: <<}`.
      // The id is its identity — replies append without an upgrade rewrite
      // and the panel key is stable from the start. Guard: inserting inside
      // existing critic markup would nest and break parsing.
      if (findCursorTarget()) {
        editor.EditHelper.showNotification(
          'CriticMarkup: move the cursor out of existing markup first')
        return
      }
      markup = buildStandaloneCommentMarkup(author, tag)
      navKey = markup // anchorless: the whole raw IS the comment key
    }
    replaceSelectionWith(editor, markup)

    // Open panel + focus the empty comment for immediate typing.
    this.placement.open()
    setTimeout(() => {
      this.renderService.process(editor.writingArea)
      this.controller.refreshPanel()
      const view = this.placement.getView<ReviewView>()
      view?.focusByNavKey(navKey)
    }, 550)
  }

  private copyCleanText(): void {
    const md = this.controller.getMarkdown()
    const clean = acceptAll(md, this.controller.parser.parseTokens(md))
    navigator.clipboard?.writeText(clean).then(
      () => editor.EditHelper.showNotification('CriticMarkup: clean text copied to clipboard'),
      () => editor.EditHelper.showNotification('CriticMarkup: clipboard write failed'),
    )
  }

  private toggleAcceptedView(): void {
    const next = !this.settings.get('acceptedViewEnabled')
    this.settings.set('acceptedViewEnabled', next)
    this.renderService.acceptedView = next
    this.renderService.unwrapAll(editor.writingArea)
    this.renderService.process(editor.writingArea)
    this.controller.refreshPanel()
  }

  // ----------------------------------------------------- cursor resolution

  /**
   * Strip exactly the reveal unit the cursor sits in (v0.3.0): the anchor
   * clears `{==..==}` alone, each comment block clears alone, substitutions
   * keep their new text — consumed spellings included.
   */
  private stripAtCursor(): void {
    const found = findCursorTarget()
    if (!found) {
      editor.EditHelper.showNotification('CriticMarkup: no markup at cursor')
      return
    }
    this.controller.stripToken(found.token, found.block)
  }

  /**
   * v0.4.0: the anchor's "golden instead of egg-yellow" cannot be settled by
   * reading Typora's bundled CSS alone — dump the live DOM of the caret block
   * (text, native elements with class/inline/computed colours, outerHTML).
   */
  private dumpBlockDom(): void {
    const info = this.renderService.debugDump()
    console.log('[criticmarkup] block dump\n' + info)
    navigator.clipboard?.writeText(info).then(
      () => editor.EditHelper.showNotification('CriticMarkup: block DOM copied to clipboard'),
      () => editor.EditHelper.showNotification('CriticMarkup: block DOM logged to console'),
    )
  }

  private resolveAtCursor(accept: boolean): void {
    const found = findCursorTarget()
    const type = found?.token.type
    if (!found
      || (type !== 'addition' && type !== 'deletion' && type !== 'substitution')) {
      editor.EditHelper.showNotification('CriticMarkup: no change at cursor')
      return
    }
    this.controller.resolveTokenAt(found.token, accept, found.block)
  }

  // -------------------------------------------------------------- refresh

  // ------------------------------------------------- typora render hook

  /**
   * v0.4.2 — hook the ONE moment when a rebuilt line is ready to paint.
   *
   * Typora's `brushQueue` runs every 200ms (and 10ms after an IME commit).
   * Inside it the caret block is re-rendered by `E() -> m()`, which always
   * replaces the block's innerHTML (our wrapper spans only exist on the
   * current-DOM side of its comparison), and the caret is only restored
   * afterwards by `undo.exeCommand(i)`. `brush.expand()` then runs and ends
   * with `$(editor.sessionStr).trigger("cursorChange", styleBookmark)`.
   *
   * `cursorChange` is a jQuery custom event, so it never reaches a native
   * listener — two transports, in order of preference:
   *
   *  1. jQuery: Typora assigns `window.$ = window.jQuery` globally
   *     (`resources/appsrc/window/frame.js`, module "50").
   *  2. Wrap `editor.brush.expand`: identical timing, no jQuery dependency.
   *
   * Either way the repair runs synchronously inside the same macrotask as
   * Typora's render + caret restore, so the browser paints a single frame
   * that is already in source view. The MutationObserver guard stays as the
   * fallback and is now non-destructive.
   */
  private attachCursorChangeHook(): () => void {
    const write = editor.writingArea
    if (!write) return () => { /* nothing attached */ }

    const jq: any = (window as any).jQuery ?? (window as any).$
    if (jq && typeof jq.fn?.on === 'function') {
      const handler = () => this.renderService.repairAfterRender(write)
      try {
        jq(write).on('cursorChange', handler)
        return () => {
          try { jq(write).off('cursorChange', handler) } catch { /* best effort */ }
        }
      } catch { /* fall through to the brush wrapper */ }
    }

    const brush: any = (editor as any).brush
    const original = brush?.expand
    if (typeof original !== 'function') return () => { /* nothing attached */ }
    const service = this.renderService
    brush.expand = function (...args: unknown[]) {
      try {
        return original.apply(this, args)
      } finally {
        service.repairAfterRender(write)
      }
    }
    return () => {
      try { brush.expand = original } catch { /* best effort */ }
    }
  }

  /** Panel-only refresh (editor rendering is the framework's business). */
  private schedulePanelRefresh(): void {
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.controller.refreshPanel()
    }, 250)
  }

  /**
   * v0.4.5: full re-scan — re-render the editor (so every chip carries its
   * nav key again) and rebuild the panel from the live markdown. Used by the
   * Refresh button/command and whenever the panel becomes visible.
   */
  private refreshReviewPanel(delay = 0): void {
    window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.renderService.process(editor.writingArea)
      this.controller.refreshPanel()
    }, delay)
  }
}
