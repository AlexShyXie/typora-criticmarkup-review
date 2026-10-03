import type { CriticTypeTag } from './types'

/** Markup builders for the F1 insert commands. */

export function buildAddition(text: string): string {
  return `{++${text}++}`
}

export function buildDeletion(text: string): string {
  return `{--${text}--}`
}

export function buildHighlight(text: string): string {
  return `{==${text}==}`
}

export function buildSubstitution(oldText: string, newText: string): string {
  return `{~~${oldText}~>${newText}~~}`
}
