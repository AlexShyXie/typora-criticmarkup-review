/**
 * Lightweight modal for quick text input (substitution target, comment body).
 * Native DOM only — no framework dependency, fully self-contained.
 */

export interface PromptOptions {
  title: string
  placeholder?: string
  initialValue?: string
  multiline?: boolean
  confirmLabel?: string
  onConfirm(value: string): void
  onCancel?(): void
}

export function promptText(options: PromptOptions): void {
  const overlay = document.createElement('div')
  overlay.className = 'critic-modal-overlay'

  const card = document.createElement('div')
  card.className = 'critic-modal-card'

  const title = document.createElement('div')
  title.className = 'critic-modal-title'
  title.textContent = options.title

  const input = document.createElement(options.multiline ? 'textarea' : 'input') as
    HTMLInputElement | HTMLTextAreaElement
  input.className = 'critic-modal-input'
  if (!(options.multiline)) (input as HTMLInputElement).type = 'text'
  input.placeholder = options.placeholder ?? ''
  input.value = options.initialValue ?? ''

  const hint = document.createElement('div')
  hint.className = 'critic-modal-hint'
  hint.textContent = options.multiline ? 'Ctrl+Enter to confirm · Esc to cancel' : 'Enter to confirm · Esc to cancel'

  const actions = document.createElement('div')
  actions.className = 'critic-modal-actions'

  const close = () => {
    overlay.remove()
    options.onCancel?.()
  }
  const confirm = () => {
    const value = input.value
    overlay.remove()
    options.onConfirm(value)
  }

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'critic-btn critic-btn-reject'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.onclick = close

  const okBtn = document.createElement('button')
  okBtn.className = 'critic-btn critic-btn-accept'
  okBtn.textContent = options.confirmLabel ?? 'OK'
  okBtn.onclick = confirm

  actions.append(cancelBtn, okBtn)
  card.append(title, input, hint, actions)
  overlay.appendChild(card)
  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) close()
  })
  document.body.appendChild(overlay)

  ;(input as HTMLElement).addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter' && (options.multiline ? (e.ctrlKey || e.metaKey) : true)) {
      e.preventDefault()
      confirm()
    }
  })

  setTimeout(() => {
    input.focus()
    if (!options.multiline) (input as HTMLInputElement).select()
  }, 30)
}
