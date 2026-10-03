import { editor } from 'typora'
import type { CriticToken } from '../critic/types'

/**
 * Write-back primitive: replace a DOM range in the editor with new text
 * through Typora's own paste pipeline, so undo / cursor / re-parsing all
 * behave like a user edit. (Pattern validated in bibtex-citation v3.)
 */

export class WritebackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WritebackError'
  }
}

/**
 * Find the rendered token span in the editor and replace the whole token
 * range with `replacement` (empty string = remove).
 *
 * @param tokenSource Expected raw markup; used as a staleness check: the
 *   live DOM must still contain exactly this text at the token anchor.
 */
export function replaceTokenInEditor(
  anchorEl: HTMLElement,
  tokenSource: string,
  replacement: string,
): void {
  const range = buildTokenRange(anchorEl, tokenSource)
  if (!range) {
    throw new WritebackError(
      'The document changed before the edit could be applied. Reopen the panel and retry.')
  }

  const selection = window.getSelection()
  if (!selection) throw new WritebackError('No selection available.')
  selection.removeAllRanges()
  selection.addRange(range)

  editor.UserOp.pasteHandler(editor, replacement, true)
}

/**
 * Build a DOM Range covering the token. The renderer marks each processed
 * block with `data-critic-block` and each token span with a start anchor
 * comment node; the raw text is verified before use.
 */
function buildTokenRange(anchorEl: HTMLElement, tokenSource: string): Range | null {
  const block = anchorEl.closest('[data-critic-block]') as HTMLElement | null
  if (!block) return null

  const text = block.textContent ?? ''
  const index = text.indexOf(tokenSource)
  if (index === -1) return null

  const range = document.createRange()
  if (!locate(range, block, index, index + tokenSource.length)) return null
  return range
}

/** Map a text-content offset pair onto real text nodes within `root`. */
function locate(range: Range, root: HTMLElement, from: number, to: number): boolean {
  const start = findPosition(root, from)
  const end = findPosition(root, to)
  if (!start || !end) return false
  try {
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
  } catch {
    return false
  }
  return true
}

function findPosition(
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } | null {
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
  // Offset at the very end.
  const last = walker.lastChild()
  if (last) {
    return { node: last, offset: last.textContent?.length ?? 0 }
  }
  return null
}

/**
 * Replace a plain text range (no token anchor) — used for inserting markup
 * over the current selection.
 */
export function replaceSelectionWith(editorObj: typeof editor, text: string): void {
  editorObj.UserOp.pasteHandler(editorObj, text, true)
}
