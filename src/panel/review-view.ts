import {
  WorkspaceView,
  type PluginSettings,
  type WorkspaceLeaf,
} from '@typora-community-plugin/core'
import type {
  ChangePanelEntry,
  CommentPanelEntry,
  CriticTypeTag,
} from '../critic/types'

/**
 * The merged review panel: quick actions toolbar + tracked changes list +
 * comment threads (with inline editing), hosted in Typora's right dock.
 */

export const REVIEW_VIEW_TYPE = 'AlexShyXie.criticmarkup-review'
export const REVIEW_VIEW_URI = `typ://${REVIEW_VIEW_TYPE}/Review`

export interface ReviewViewActions {
  /** Re-render with fresh data. */
  refresh(data: ReviewPanelData, force?: boolean): void
}

export interface ReviewPanelData {
  changes: ChangePanelEntry[]
  comments: CommentPanelEntry[]
  acceptedView: boolean
  authorName: string
}

export interface ReviewViewCallbacks {
  onQuickAction(action: QuickActionType): void
  onAcceptChange(entry: ChangePanelEntry): void
  onRejectChange(entry: ChangePanelEntry): void
  onNavigateChange(entry: ChangePanelEntry): void
  onNavigateComment(entry: CommentPanelEntry): void
  onEditComment(entry: CommentPanelEntry, body: string, tag: CriticTypeTag): void
  onReplyComment(entry: CommentPanelEntry, body: string): void
  onEditReply(entry: CommentPanelEntry, replyIndex: number, body: string): void
  onResolveComment(entry: CommentPanelEntry): void
  onToggleAcceptedView(): void
  onAcceptAll(): void
  onRefreshPanel(): void
}

export type QuickActionType = 'add' | 'delete' | 'highlight' | 'replace' | 'comment' | 'strip'

const QUICK_ACTIONS: { type: QuickActionType; label: string; title: string }[] = [
  { type: 'add', label: '+', title: 'Mark selection as addition' },
  { type: 'delete', label: '−', title: 'Mark selection as deletion' },
  { type: 'highlight', label: '▮', title: 'Mark selection as highlight' },
  { type: 'replace', label: '⇄', title: 'Mark selection as replace' },
  { type: 'comment', label: '💬', title: 'Comment on selection' },
  { type: 'strip', label: '🧹', title: 'Strip CriticMarkup markup at cursor (accept)' },
]

const TAG_LABEL: Record<CriticTypeTag, string> = {
  ASK: '❓ ASK', EDIT: '✏️ EDIT', PRAISE: '👍 PRAISE', NOTE: '💬 NOTE', REPLY: '↩ REPLY',
}

export class ReviewView extends WorkspaceView implements ReviewViewActions {

  static type = REVIEW_VIEW_TYPE

  private data: ReviewPanelData = {
    changes: [], comments: [], acceptedView: false, authorName: '',
  }

  /** Thread key currently being edited (one at a time). */
  private editingKey: string | null = null
  /** Reply currently being edited (click a reply row in the panel). */
  private editingReply: { entryId: string; index: number } | null = null
  /** Editor box to re-focus after the next render (instant tag switch). */
  private pendingFocusKey: string | null = null
  /** Reply box open for thread key. */
  private replyingKey: string | null = null
  /** Data arrived while the user was interacting; render on focusout. */
  private pendingRender = false

  constructor(
    leaf: WorkspaceLeaf,
    private callbacks: ReviewViewCallbacks,
    private settings?: PluginSettings<{ defaultTypeTag: CriticTypeTag }>,
  ) {
    super(leaf)
    this.containerEl = document.createElement('section')
  }

  getViewType() { return REVIEW_VIEW_TYPE }

  onOpen(): void {
    // When focus leaves the panel, apply a deferred re-render (if any).
    // Focus moves *within* the panel (textarea -> tag button) must NOT
    // flush: the re-render would replace the button mid-click and swallow
    // the click (that was the "cannot switch type" bug).
    this.containerEl.addEventListener('focusout', (e) => {
      const to = e.relatedTarget
      if (to instanceof Node && this.containerEl.contains(to)) return
      setTimeout(() => this.flushPendingRender(), 0)
    })
    this.render()
  }

  refresh(data: ReviewPanelData, force = false): void {
    // Keep editor state (editing/replying) across refreshes triggered by
    // our own write-backs; drop it when entries vanished.
    if (this.editingKey && !data.comments.some(c => c.id === this.editingKey)) {
      this.editingKey = null
    }
    if (this.editingReply && !data.comments.some(c => c.id === this.editingReply!.entryId)) {
      this.editingReply = null
    }
    if (this.replyingKey && !data.comments.some(c => c.id === this.replyingKey)) {
      this.replyingKey = null
    }
    this.data = data
    // Never rebuild the DOM while the user is interacting with the panel
    // (typing / choosing a tag / clicking buttons) — that is what made the
    // edit box lose focus instantly. Defer until they leave the panel.
    if (!force && this.isInteracting()) {
      this.pendingRender = true
      return
    }
    this.pendingRender = false
    if (this.containerEl.isConnected) this.render()
  }

  /** True while an input / select / button inside the panel has focus. */
  private isInteracting(): boolean {
    const el = document.activeElement
    if (!el || !(el instanceof HTMLElement)) return false
    if (!this.containerEl.contains(el)) return false
    const tag = el.tagName
    return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON'
  }

  private flushPendingRender(): void {
    if (this.pendingRender && !this.isInteracting()) {
      this.pendingRender = false
      if (this.containerEl.isConnected) this.render()
    }
  }

  /** Focus the editor for a newly inserted empty comment. */
  focusEditorFor(entryId: string): void {
    this.editingKey = entryId
    this.render()
    const textarea = this.containerEl.querySelector<HTMLTextAreaElement>(
      `textarea[data-edit-thread="${CSS.escape(entryId)}"]`)
    textarea?.focus()
  }

  /** Open the editor for the thread whose first comment matches `navKey`. */
  focusByNavKey(navKey: string): void {
    const entry = this.data.comments.find(c => {
      const first = c.thread.first
      const commentOnly = first.raw.slice(first.anchored ? first.anchored.highlightRaw.length : 0)
      return commentOnly === navKey || first.raw === navKey
    })
    if (entry) {
      this.editingKey = entry.id
      this.render()
      const textarea = this.containerEl.querySelector<HTMLTextAreaElement>(
        `textarea[data-edit-thread="${CSS.escape(entry.id)}"]`)
      textarea?.focus()
      textarea?.scrollIntoView({ block: 'nearest' })
    }
  }

  /** Flash a comment card (e.g. clicked chip in editor). */
  highlightByNavKey(navKey: string): void {
    const entry = this.data.comments.find(c => {
      const first = c.thread.first
      const commentOnly = first.raw.slice(first.anchored ? first.anchored.highlightRaw.length : 0)
      return commentOnly === navKey || first.raw === navKey
    })
    if (!entry) return
    const card = this.containerEl.querySelector(`[data-entry-id="${CSS.escape(entry.id)}"]`)
    if (card) {
      card.classList.add('is-flash')
      card.scrollIntoView({ block: 'nearest' })
      setTimeout(() => card.classList.remove('is-flash'), 1200)
    }
  }

  // ------------------------------------------------------------- rendering

  private render(): void {
    const root = this.containerEl
    root.className = 'critic-review-view'
    root.replaceChildren()

    const wrap = document.createElement('div')
    wrap.className = 'critic-review-wrap'

    wrap.append(this.renderToolbar())

    const changes = this.renderChanges()
    const comments = this.renderComments()
    wrap.append(changes, comments)

    root.appendChild(wrap)

    // Instant tag switch: the write-back's forced refresh re-rendered the
    // editor box — put the caret back so typing can continue seamlessly.
    if (this.pendingFocusKey) {
      const key = this.pendingFocusKey
      this.pendingFocusKey = null
      this.containerEl.querySelector<HTMLTextAreaElement>(
        `textarea[data-edit-thread="${CSS.escape(key)}"]`)?.focus()
    }
  }

  private renderToolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'critic-toolbar'

    const actions = document.createElement('div')
    actions.className = 'critic-toolbar-actions'
    for (const qa of QUICK_ACTIONS) {
      const btn = document.createElement('button')
      btn.className = 'critic-btn critic-btn-quick'
      btn.textContent = qa.label
      btn.title = qa.title
      btn.onclick = () => this.callbacks.onQuickAction(qa.type)
      actions.append(btn)
    }
    bar.append(actions)

    const modes = document.createElement('div')
    modes.className = 'critic-toolbar-modes'

    const accepted = document.createElement('button')
    accepted.className = `critic-btn critic-btn-toggle${this.data.acceptedView ? ' is-on' : ''}`
    accepted.textContent = `Accepted view: ${this.data.acceptedView ? 'On' : 'Off'}`
    accepted.title = 'Render the document as if every change were accepted'
    accepted.onclick = () => this.callbacks.onToggleAcceptedView()

    const acceptAll = document.createElement('button')
    acceptAll.className = 'critic-btn critic-btn-toggle'
    acceptAll.textContent = 'Accept all'
    acceptAll.title = 'Accept every tracked change (comments are kept)'
    acceptAll.disabled = this.data.changes.length === 0
    acceptAll.onclick = () => this.callbacks.onAcceptAll()

    const refresh = document.createElement('button')
    refresh.className = 'critic-btn critic-btn-toggle'
    refresh.textContent = 'Refresh'
    refresh.title = 'Re-scan the document and rebuild the panel'
    refresh.onclick = () => this.callbacks.onRefreshPanel()

    modes.append(accepted, acceptAll, refresh)
    bar.append(modes)
    return bar
  }

  private renderChanges(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'critic-section'

    const title = document.createElement('div')
    title.className = 'critic-section-title'
    title.textContent = `Changes in current note (${this.data.changes.length})`
    section.append(title)

    if (this.data.changes.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'critic-empty'
      empty.textContent = 'No tracked changes.'
      section.append(empty)
      return section
    }

    for (const entry of this.data.changes) {
      section.append(this.renderChangeCard(entry))
    }
    return section
  }

  private renderChangeCard(entry: ChangePanelEntry): HTMLElement {
    const card = document.createElement('div')
    card.className = `critic-card critic-change critic-change-${entry.token.type}`

    // Navigating closes any open comment editor box (issue: box lingered).
    const navigate = () => {
      this.editingKey = null
      this.replyingKey = null
      this.editingReply = null
      this.render()
      this.callbacks.onNavigateChange(entry)
    }

    const head = document.createElement('div')
    head.className = 'critic-card-head'
    head.onclick = navigate

    const badge = document.createElement('span')
    badge.className = `critic-badge critic-badge-${entry.token.type}`
    badge.textContent = entry.token.type

    const meta = document.createElement('span')
    meta.className = 'critic-card-meta'
    meta.textContent = entry.section

    head.append(badge, meta)

    const body = document.createElement('div')
    body.className = 'critic-card-body'
    body.onclick = navigate

    const preview = document.createElement('div')
    preview.className = 'critic-change-preview'
    switch (entry.token.type) {
      case 'addition': preview.textContent = `+ ${(entry.token as any).text}`; break
      case 'deletion': preview.textContent = `− ${(entry.token as any).text}`; break
      case 'substitution': {
        const oldEl = document.createElement('span')
        oldEl.className = 'critic-preview-old'
        oldEl.textContent = (entry.token as any).oldText
        const arrow = document.createElement('span')
        arrow.className = 'critic-preview-plain'
        arrow.textContent = ' → '
        const newEl = document.createElement('span')
        newEl.className = 'critic-preview-new'
        newEl.textContent = (entry.token as any).newText
        preview.append(oldEl, arrow, newEl)
        break
      }
    }
    body.append(preview)

    const ops = document.createElement('div')
    ops.className = 'critic-card-ops'
    ops.append(
      this.opButton('Accept', 'critic-btn-accept', () => this.callbacks.onAcceptChange(entry)),
      this.opButton('Reject', 'critic-btn-reject', () => this.callbacks.onRejectChange(entry)),
    )

    card.append(head, body, ops)
    return card
  }

  private renderComments(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'critic-section'

    const title = document.createElement('div')
    title.className = 'critic-section-title'
    title.textContent = `Comments in current note (${this.data.comments.length})`
    section.append(title)

    if (this.data.comments.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'critic-empty'
      empty.textContent = 'No comments.'
      section.append(empty)
      return section
    }

    for (const entry of this.data.comments) {
      section.append(this.renderCommentCard(entry))
    }
    return section
  }

  private renderCommentCard(entry: CommentPanelEntry): HTMLElement {
    const card = document.createElement('div')
    card.className = 'critic-card critic-comment-card'

    // Navigating from the panel closes any open editor box first (the box
    // used to linger forever when clicking other entries).
    const navigate = () => {
      this.editingKey = null
      this.replyingKey = null
      this.editingReply = null
      this.render()
      this.callbacks.onNavigateComment(entry)
    }

    const head = document.createElement('div')
    head.className = 'critic-card-head'
    head.onclick = navigate

    const badge = document.createElement('span')
    badge.className = `critic-badge critic-badge-tag-${entry.thread.first.typeTag.toLowerCase()}`
    badge.textContent = TAG_LABEL[entry.thread.first.typeTag]

    const meta = document.createElement('span')
    meta.className = 'critic-card-meta'
    const author = entry.thread.first.author ?? 'anonymous'
    const bits = [author]
    if (entry.thread.first.date) bits.push(entry.thread.first.date)
    bits.push(`Line ${entry.thread.line}`)
    meta.textContent = bits.join(' · ')

    head.append(badge, meta)

    const body = document.createElement('div')
    body.className = 'critic-card-body'

    if (this.editingKey === entry.id) {
      body.append(this.renderCommentEditor(entry))
    } else {
      const text = document.createElement('div')
      text.className = 'critic-comment-body'
      text.textContent = entry.thread.first.body || '(empty comment)'
      if (!entry.thread.first.body) text.classList.add('critic-comment-empty')
      text.onclick = () => {
        this.editingKey = entry.id
        this.replyingKey = null
        this.editingReply = null
        this.render()
        this.containerEl.querySelector<HTMLTextAreaElement>(
          `textarea[data-edit-thread="${CSS.escape(entry.id)}"]`)?.focus()
      }
      body.append(text)
    }

    entry.thread.replies.forEach((reply, replyIndex) => {
      const r = document.createElement('div')
      r.className = 'critic-reply'
      const rHead = document.createElement('div')
      rHead.className = 'critic-reply-head'
      const rBadge = document.createElement('span')
      rBadge.className = 'critic-badge critic-badge-tag-reply'
      rBadge.textContent = TAG_LABEL.REPLY
      rHead.append(rBadge, document.createTextNode(
        `${reply.author ?? 'anonymous'}${reply.date ? ' · ' + reply.date : ''}`))
      const editingThis = this.editingReply?.entryId === entry.id
        && this.editingReply.index === replyIndex
      if (editingThis) {
        r.append(rHead, this.renderReplyEditor(entry, replyIndex, reply))
      } else {
        const rBody = document.createElement('div')
        rBody.className = 'critic-reply-body'
        rBody.textContent = reply.body
        // v0.3.0: clicking a reply row opens an inline editor for THAT
        // reply (was dead — replies could never be edited from the panel).
        const open = () => {
          this.editingReply = { entryId: entry.id, index: replyIndex }
          this.editingKey = null
          this.replyingKey = null
          this.render()
          this.containerEl.querySelector<HTMLTextAreaElement>(
            `textarea[data-edit-reply="${CSS.escape(entry.id)}"][data-reply-index="${replyIndex}"]`,
          )?.focus()
        }
        rHead.onclick = open
        rBody.onclick = open
        r.append(rHead, rBody)
      }
      body.append(r)
    })

    if (this.replyingKey === entry.id) {
      body.append(this.renderReplyBox(entry))
    }

    const ops = document.createElement('div')
    ops.className = 'critic-card-ops'
    ops.append(
      this.opButton('Edit', 'critic-btn-edit', () => {
        this.editingKey = entry.id
        this.replyingKey = null
        this.editingReply = null
        this.render()
        this.containerEl.querySelector<HTMLTextAreaElement>(
          `textarea[data-edit-thread="${CSS.escape(entry.id)}"]`)?.focus()
      }),
      this.opButton('Reply', 'critic-btn-reply', () => {
        this.replyingKey = entry.id
        this.editingKey = null
        this.editingReply = null
        this.render()
        this.containerEl.querySelector<HTMLTextAreaElement>(
          `textarea[data-reply-thread="${CSS.escape(entry.id)}"]`)?.focus()
      }),
      this.opButton('Resolve', 'critic-btn-resolve', () => this.callbacks.onResolveComment(entry)),
    )

    card.append(head, body, ops)
    return card
  }

  private renderCommentEditor(entry: CommentPanelEntry): HTMLElement {
    const box = document.createElement('div')
    box.className = 'critic-editor-box'

    const textarea = document.createElement('textarea')
    textarea.className = 'critic-textarea'
    textarea.dataset.editThread = entry.id
    textarea.value = entry.thread.first.body
    textarea.rows = Math.max(2, Math.min(8, entry.thread.first.body.split('\n').length + 1))

    const tagRow = document.createElement('div')
    tagRow.className = 'critic-tag-row'
    const current = entry.thread.first.typeTag === 'REPLY' ? 'NOTE' : entry.thread.first.typeTag
    for (const tag of (['ASK', 'EDIT', 'PRAISE', 'NOTE'] as CriticTypeTag[])) {
      const b = document.createElement('button')
      b.className = `critic-btn critic-btn-tag${current === tag ? ' is-active' : ''}`
      b.textContent = tag
      b.dataset.tag = tag
      b.onclick = () => {
        // Instant switch: apply the type AND the current text right away,
        // keep the editor open (the write-back's forced refresh re-renders
        // the box with the new tag as `current`).
        if (tag === current && !textarea.value) return
        this.pendingFocusKey = entry.id
        this.callbacks.onEditComment(entry, textarea.value, tag)
      }
      tagRow.append(b)
    }

    const actions = document.createElement('div')
    actions.className = 'critic-editor-actions'
    actions.append(
      this.opButton('Save', 'critic-btn-accept', () => {
        this.callbacks.onEditComment(entry, textarea.value, current)
        this.editingKey = null
      }),
      this.opButton('Cancel', 'critic-btn-reject', () => {
        this.editingKey = null
        this.render()
      }),
    )

    const hint = document.createElement('div')
    hint.className = 'critic-editor-hint'
    hint.textContent = 'Ctrl+Enter to save · Esc to cancel · type switches instantly'

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        this.callbacks.onEditComment(entry, textarea.value, current)
        this.editingKey = null
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.editingKey = null
        this.render()
      }
    })

    box.append(textarea, tagRow, actions, hint)
    return box
  }

  private renderReplyBox(entry: CommentPanelEntry): HTMLElement {
    const box = document.createElement('div')
    box.className = 'critic-editor-box critic-reply-box'

    const textarea = document.createElement('textarea')
    textarea.className = 'critic-textarea'
    textarea.dataset.replyThread = entry.id
    textarea.rows = 2

    const actions = document.createElement('div')
    actions.className = 'critic-editor-actions'
    actions.append(
      this.opButton('Send', 'critic-btn-accept', () => {
        if (textarea.value.trim()) {
          this.callbacks.onReplyComment(entry, textarea.value)
          this.replyingKey = null
        }
      }),
      this.opButton('Cancel', 'critic-btn-reject', () => {
        this.replyingKey = null
        this.render()
      }),
    )

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        if (textarea.value.trim()) {
          this.callbacks.onReplyComment(entry, textarea.value)
          this.replyingKey = null
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.replyingKey = null
        this.render()
      }
    })

    box.append(textarea, actions)
    return box
  }

  /** Inline editor for ONE existing reply (v0.3.0). */
  private renderReplyEditor(
    entry: CommentPanelEntry, replyIndex: number, reply: { body: string },
  ): HTMLElement {
    const box = document.createElement('div')
    box.className = 'critic-editor-box critic-reply-box'

    const textarea = document.createElement('textarea')
    textarea.className = 'critic-textarea'
    textarea.dataset.editReply = entry.id
    textarea.dataset.replyIndex = String(replyIndex)
    textarea.value = reply.body
    textarea.rows = Math.max(2, Math.min(8, reply.body.split('\n').length + 1))

    const close = () => {
      this.editingReply = null
      this.render()
    }
    const commit = () => {
      this.editingReply = null
      this.callbacks.onEditReply(entry, replyIndex, textarea.value)
    }

    const actions = document.createElement('div')
    actions.className = 'critic-editor-actions'
    actions.append(
      this.opButton('Save', 'critic-btn-accept', commit),
      this.opButton('Cancel', 'critic-btn-reject', close),
    )

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })

    box.append(textarea, actions)
    return box
  }

  private opButton(label: string, cls: string, onclick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = `critic-btn ${cls}`
    btn.textContent = label
    btn.onclick = onclick
    return btn
  }
}
