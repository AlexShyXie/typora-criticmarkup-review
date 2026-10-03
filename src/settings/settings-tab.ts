import { SettingTab, type Plugin } from '@typora-community-plugin/core'
import type { CriticTypeTag } from '../critic/types'
import { SELECTABLE_TYPE_TAGS } from '../critic/syntax'
import type { ReviewSettings } from './model'

/**
 * Minimal settings tab: author name, default comment type, panel auto-open.
 */
export class ReviewSettingsTab extends SettingTab {

  constructor(private readonly plugin: Plugin<ReviewSettings>) {
    super()
    this.containerEl.classList.add('critic-review-settings')
  }

  get name() { return this.plugin.manifest.name }

  onshow() {
    this.containerEl.replaceChildren()
    const s = this.plugin.settings

    this.addSettingTitle('Comments')
    this.addSetting(item => {
      item.addName('Author name')
      item.addDescription('Written into new comments so reviewers can tell who wrote what.')
      item.addText(input => {
        input.value = s.get('authorName') ?? ''
        input.placeholder = 'e.g. Hui'
        input.addEventListener('change', () => s.set('authorName', input.value.trim()))
      })
    })
    this.addSetting(item => {
      item.addName('Default comment type')
      item.addDescription('Tag applied to new comments. ASK / EDIT / PRAISE / NOTE.')
      item.addSelect(input => {
        for (const tag of SELECTABLE_TYPE_TAGS) {
          const option = document.createElement('option')
          option.value = tag
          option.textContent = tag
          input.append(option)
        }
        input.value = s.get('defaultTypeTag') ?? 'NOTE'
        input.addEventListener('change', () => s.set('defaultTypeTag', input.value as CriticTypeTag))
      })
    })

    this.addSettingTitle('Panel')
    this.addSetting(item => {
      item.addName('Open panel automatically')
      item.addDescription('Open the review panel when Typora starts with this plugin enabled.')
      item.addCheckbox(input => {
        input.checked = s.get('autoOpenPanel') === true
        input.addEventListener('change', () => s.set('autoOpenPanel', input.checked))
      })
    })

    this.addSettingTitle('View')
    this.addSetting(item => {
      item.addName('Accepted view')
      item.addDescription('Render the document as if every change were accepted (comments stay visible).')
      item.addCheckbox(input => {
        input.checked = s.get('acceptedViewEnabled') === true
        input.addEventListener('change', () => s.set('acceptedViewEnabled', input.checked))
      })
    })
  }
}
