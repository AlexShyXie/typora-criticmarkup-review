import type { CriticTypeTag } from '../critic/types'

export interface ReviewSettings {
  /** Default author name written into new comments. */
  authorName: string
  /** Default comment type tag. */
  defaultTypeTag: CriticTypeTag
  /** Open the review panel automatically on plugin load. */
  autoOpenPanel: boolean
  /** Whether the "accepted view" rendering mode is on. */
  acceptedViewEnabled: boolean
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  authorName: '',
  defaultTypeTag: 'NOTE',
  autoOpenPanel: false,
  acceptedViewEnabled: false,
}
