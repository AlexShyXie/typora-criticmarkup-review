import type { App } from '@typora-community-plugin/core'
import { REVIEW_VIEW_TYPE, REVIEW_VIEW_URI } from '../panel/review-view'

export interface RightDockLeaf {
  type: string
  viewType: string
  view: unknown
  detach(): void
}

export interface RightDockApp {
  commands: {
    run(commandId: string, args: unknown[]): void
  }
  workspace: {
    rightSplit: {
      findLeaf(predicate: (leaf: RightDockLeaf) => boolean): RightDockLeaf | null
      filterLeaves(predicate: (leaf: RightDockLeaf) => boolean): RightDockLeaf[]
      expand(): void
      toggle(): void
      /** `WorkspaceSidedock.collapsed`; absent on cores that lack it. */
      collapsed?: boolean
    }
  }
}

/** Mount / toggle / query the review panel in Typora's right dock. */
export class RightDockPlacement {
  constructor(private readonly app: App) {}

  private findLeaf() {
    const dock = (this.app as unknown as RightDockApp).workspace.rightSplit
    return dock.findLeaf(leaf => leaf.viewType === REVIEW_VIEW_TYPE)
  }

  open() {
    if (!this.findLeaf()) {
      ;(this.app as unknown as RightDockApp).commands.run(
        'core.workspace.right-split:ensure-leaf',
        [REVIEW_VIEW_URI],
      )
    }
    ;(this.app as unknown as RightDockApp).workspace.rightSplit.expand()
  }

  toggle() {
    if (!this.findLeaf()) {
      this.open()
      return
    }
    ;(this.app as unknown as RightDockApp).workspace.rightSplit.toggle()
  }

  isOpen() {
    return this.findLeaf() !== null
  }

  /**
   * v0.4.5: the leaf can exist while the dock is folded away. Refreshing a
   * hidden panel is pure waste (it re-wraps the whole editor on the way), so
   * the toggle command refreshes only when the panel is actually on screen.
   * A core without `collapsed` degrades to "leaf exists == visible".
   */
  isVisible() {
    if (!this.findLeaf()) return false
    const dock = (this.app as unknown as RightDockApp).workspace.rightSplit
    return dock.collapsed !== true
  }

  getView<T = unknown>(): T | null {
    return (this.findLeaf()?.view as T | undefined) ?? null
  }

  dispose() {
    const dock = (this.app as unknown as RightDockApp).workspace.rightSplit
    const leaves = dock.filterLeaves(leaf => leaf.viewType === REVIEW_VIEW_TYPE)
    for (const leaf of leaves) leaf.detach()
  }
}
