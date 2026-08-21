import type { Card } from 'ts-fsrs'

export const LANGUAGE_TUTOR_EVENT = 'language-tutor/card' as const

export type CheckMode = 'off' | 'on' | 'context'

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export interface TutorSettings {
  readonly learning: string
  readonly native: string
  readonly check: CheckMode
  readonly tutor: boolean
  readonly auto: boolean
  readonly context: boolean
  readonly route?: ModelRoute
}

export interface GrammarItem {
  readonly wrong: string
  readonly right: string
  readonly reason: string
}

export interface TutorWord {
  readonly word: string
  readonly note: string
}

export interface TutorGrammar {
  readonly structure: string
  readonly note: string
}

export interface TutorResult {
  readonly sentence: string
  readonly words: readonly TutorWord[]
  readonly grammar: readonly TutorGrammar[]
}

export type ReviewResult =
  | { readonly mode: 'check'; readonly items: readonly GrammarItem[]; readonly rephrase: string | null }
  | { readonly mode: 'tutor'; readonly tutor: TutorResult }
  | { readonly mode: 'skip' }

export type MarkdownSegment =
  | { readonly kind: 'prose'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string; readonly lines: number }

export type TranslationSegment =
  | { readonly kind: 'pair'; readonly source: string; readonly translation: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'code-ref'; readonly lines: number }

export interface ReviewCard {
  readonly kind: 'review'
  readonly mode: 'check' | 'tutor'
  readonly learning: string
  readonly native: string
  readonly items?: readonly GrammarItem[]
  readonly rephrase?: string
  readonly tutor?: TutorResult
  readonly addedCards: number
}

export interface TranslationCard {
  readonly kind: 'translation'
  readonly native: string
  readonly segments?: readonly TranslationSegment[]
  readonly text?: string
}

export type FlashcardStage = 'question' | 'answer' | 'rated' | 'empty'

export interface FlashcardCard {
  readonly kind: 'flashcard'
  readonly stage: FlashcardStage
  readonly reviewId: string
  readonly cardId?: string
  readonly word?: string
  readonly note?: string
  readonly rating?: number
  readonly nextDue?: string
  readonly remaining: number
  readonly message?: string
}

export type LanguageTutorCard = ReviewCard | TranslationCard | FlashcardCard

export interface LanguageTutorEventData {
  readonly cardId: string
  readonly role: 'start' | 'update'
  readonly card: LanguageTutorCard
}

export interface FlashcardEntry {
  readonly id: string
  word: string
  note: string
  readonly source: 'tutor' | 'manual'
  readonly createdAt: string
  introducedAt?: string
  fsrs: Card
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, presentation-only language-learning result. */
    'language-tutor/card': LanguageTutorEventData
  }
}
