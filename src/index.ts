import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { LlmCallConfig, Message } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import type { Grade } from 'ts-fsrs'
import {
  assembleTranslationSegments,
  buildReviewPrompt,
  buildSegmentTranslationPrompt,
  buildWholeTranslationPrompt,
  contentUnits,
  DEFAULT_SETTINGS,
  displayRoute,
  MAX_TRANSLATE_CHARS,
  MIN_AUTO_UNITS,
  normalizeSettings,
  parseModelRoute,
  parseReviewResult,
  parseSegmentTranslations,
  segmentMarkdown,
  shouldSkipCheck,
  splitTranslationText,
  TRANSLATION_BATCH_CHARS,
} from './core.js'
import { AuxiliaryLlmError, runAuxiliaryLlm } from './llm.js'
import { FlashcardStore, isRetryGrade, Rating, SettingsStore } from './store.js'
import {
  LANGUAGE_TUTOR_EVENT,
  type FlashcardCard,
  type FlashcardEntry,
  type LanguageTutorCard,
  type ModelRoute,
  type TranslationCard,
  type TutorSettings,
} from './types.js'

export const name = 'dsh-language-tutor'
export const inject = ['agents', 'commands', 'llm']

// DSH 0.1.1-rc.2 deliberately has no downstream event-registration service.
// Registering the presentation-only event here keeps persisted sessions
// readable until that public surface lands.
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(LANGUAGE_TUTOR_EVENT)

export interface Config {
  readonly dshHome?: string
  readonly learning?: string
  readonly native?: string
  readonly check?: 'off' | 'on' | 'context'
  readonly tutor?: boolean
  readonly auto?: boolean
  readonly context?: boolean
  readonly provider?: string
  readonly model?: string
  /** Legacy shared limit; the more specific limits take precedence. */
  readonly maxOutputTokens?: number
  readonly reviewMaxOutputTokens?: number
  readonly translationMaxOutputTokens?: number
  readonly timeoutMs?: number
  readonly retries?: number
  readonly flashcardSessionLimit?: number
  readonly flashcardNewPerDay?: number
  readonly requestRetention?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  learning: z.string().default('en'),
  native: z.string().default('zh-CN'),
  check: z.union(['off', 'on', 'context'] as const).default('on'),
  tutor: z.boolean().default(true),
  auto: z.boolean().default(false),
  context: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
  maxOutputTokens: z.number().step(1).min(128),
  reviewMaxOutputTokens: z.number().step(1).min(128),
  translationMaxOutputTokens: z.number().step(1).min(128),
  timeoutMs: z.number().step(1).min(1_000).default(30_000),
  retries: z.number().step(1).min(0).max(2).default(1),
  flashcardSessionLimit: z.number().step(1).min(1).default(20),
  flashcardNewPerDay: z.number().step(1).min(0).default(10),
  requestRetention: z.number().min(0.7).max(0.99).default(0.9),
})

interface ResolvedConfig {
  readonly dshHome?: string
  readonly initialSettings: TutorSettings
  readonly reviewMaxOutputTokens: number
  readonly translationMaxOutputTokens: number
  readonly timeoutMs: number
  readonly retries: number
  readonly flashcardSessionLimit: number
  readonly flashcardNewPerDay: number
  readonly requestRetention: number
}

interface ReviewQueue {
  readonly queue: string[]
  current?: {
    readonly reviewId: string
    readonly cardId: string
    revealed: boolean
  }
}

interface TranslationPiece {
  readonly segmentIndex: number
  readonly text: string
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isInteger(value) && value !== undefined
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function resolveConfig(config: Config = {}): ResolvedConfig {
  const provider = config.provider?.trim()
  const model = config.model?.trim()
  if ((provider === undefined) !== (model === undefined) || provider === '' || model === '') {
    throw new Error('dsh-language-tutor: provider and model must be supplied together and be non-empty')
  }
  const route = provider !== undefined && model !== undefined ? { provider, model } : undefined
  const legacyMaxOutputTokens = config.maxOutputTokens === undefined
    ? undefined
    : integer(config.maxOutputTokens, 1_200, 128)
  return {
    ...config.dshHome === undefined ? {} : { dshHome: config.dshHome },
    initialSettings: normalizeSettings({
      learning: config.learning ?? DEFAULT_SETTINGS.learning,
      native: config.native ?? DEFAULT_SETTINGS.native,
      check: config.check ?? DEFAULT_SETTINGS.check,
      tutor: config.tutor ?? DEFAULT_SETTINGS.tutor,
      auto: config.auto ?? DEFAULT_SETTINGS.auto,
      context: config.context ?? DEFAULT_SETTINGS.context,
      ...route === undefined ? {} : { route },
    }),
    reviewMaxOutputTokens: integer(
      config.reviewMaxOutputTokens,
      legacyMaxOutputTokens ?? 1_200,
      128,
    ),
    translationMaxOutputTokens: integer(
      config.translationMaxOutputTokens,
      legacyMaxOutputTokens ?? 4_096,
      128,
    ),
    timeoutMs: integer(config.timeoutMs, 30_000, 1_000),
    retries: integer(config.retries, 1, 0, 2),
    flashcardSessionLimit: integer(config.flashcardSessionLimit, 20, 1),
    flashcardNewPerDay: integer(config.flashcardNewPerDay, 10, 0),
    requestRetention: typeof config.requestRetention === 'number' && Number.isFinite(config.requestRetention)
      ? Math.min(0.99, Math.max(0.7, config.requestRetention))
      : 0.9,
  }
}

function textOf(message: Message): string {
  return message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function routeOf(message: Message): ModelRoute | undefined {
  return message.source.kind === 'model'
    ? { provider: message.source.provider, model: message.source.model }
    : undefined
}

function currentHumanMessage(agent: Agent, turn: number, step: number): Message | undefined {
  const events = agent.session.events
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'step/start' && event.data.turn === turn && event.data.step === step) {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  for (let index = events.length - 1; index > start; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') return event.data
  }
  return undefined
}

function lastAssistant(session: Session): { readonly event: SessionEvent<'assistant/message'>; readonly text: string } | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message' || event.data.interrupted === true) continue
    const text = textOf(event.data.message)
    if (text.length > 0) return { event, text }
  }
  return undefined
}

function assistantById(
  session: Session,
  messageId: string,
): { readonly event: SessionEvent<'assistant/message'>; readonly text: string } | undefined {
  for (const event of session.events) {
    if (event.type !== 'assistant/message' || event.data.message.id !== messageId || event.data.interrupted === true) continue
    const text = textOf(event.data.message)
    return text.length === 0 ? undefined : { event, text }
  }
  return undefined
}

function contextExcerpt(session: Session, omitMessageId?: string): string | undefined {
  const rows = session.deriveMessages()
    .filter(message => message.id !== omitMessageId)
    .slice(-8)
    .flatMap((message) => {
      const text = textOf(message).slice(0, 700)
      return text.length === 0 ? [] : [`${message.role}: ${text}`]
    })
  const result = rows.join('\n\n').slice(-4_500).trim()
  return result.length === 0 ? undefined : result
}

function settingsText(settings: TutorSettings): string {
  return [
    `learning: ${settings.learning}`,
    `native: ${settings.native}`,
    `check: ${settings.check}`,
    `tutor: ${settings.tutor ? 'on' : 'off'}`,
    `auto translate: ${settings.auto ? 'on' : 'off'}`,
    `translation context: ${settings.context ? 'on' : 'off'}`,
    `model: ${displayRoute(settings.route)}`,
    '',
    'Usage: /lang check off|on|context · /lang tutor on|off · /lang auto on|off',
    '       /lang native <code> · /lang learning <code> · /lang model <provider/model>|default',
    '       /lang context on|off',
  ].join('\n')
}

function boolValue(value: string): boolean | undefined {
  if (value === 'on') return true
  if (value === 'off') return false
  return undefined
}

function safeError(error: unknown): string {
  if (error instanceof AuxiliaryLlmError) return `${error.message} (${error.code})`
  return error instanceof Error ? error.message : String(error)
}

function resultError(message: string): CommandResult {
  return { kind: 'error', text: message }
}

function translationPieces(prose: readonly string[]): TranslationPiece[] {
  return prose.flatMap((text, segmentIndex) =>
    splitTranslationText(text).map(piece => ({ segmentIndex, text: piece })))
}

function translationBatches(pieces: readonly TranslationPiece[]): TranslationPiece[][] {
  const output: TranslationPiece[][] = []
  let batch: TranslationPiece[] = []
  let chars = 0
  const flush = (): void => {
    if (batch.length > 0) output.push(batch)
    batch = []
    chars = 0
  }
  for (const piece of pieces) {
    if (batch.length > 0 && chars + piece.text.length > TRANSLATION_BATCH_CHARS) flush()
    batch.push(piece)
    chars += piece.text.length
  }
  flush()
  return output
}

function translationTokenBudget(texts: readonly string[], maximum: number): number {
  const chars = texts.reduce((total, text) => total + text.length, 0)
  return Math.max(128, Math.min(maximum, Math.max(1_200, Math.ceil(chars * 1.4) + 384)))
}

function appendCard(session: Session, cardId: string, role: 'start' | 'update', card: LanguageTutorCard): number {
  return session.append(LANGUAGE_TUTOR_EVENT, { cardId, role, card }).seq
}

function hasCard(session: Session, cardId: string): boolean {
  return session.events.some(event => event.type === LANGUAGE_TUTOR_EVENT && event.data.cardId === cardId)
}

function gradeFrom(value: string): Grade | undefined {
  const normalized = value.toLowerCase()
  if (normalized === 'again' || normalized === '1') return Rating.Again
  if (normalized === 'hard' || normalized === '2') return Rating.Hard
  if (normalized === 'good' || normalized === '3') return Rating.Good
  if (normalized === 'easy' || normalized === '4') return Rating.Easy
  return undefined
}

export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const home = resolveDshHome(config.dshHome)
  const root = join(home, 'state', 'dsh-language-tutor')
  const settings = new SettingsStore(join(root, 'settings.json'), config.initialSettings)
  const flashcards = new FlashcardStore(join(root, 'flashcards.json'), config.requestRetention)
  const reviewQueues = new Map<SessionId, ReviewQueue>()
  const reviewed = new Set<string>()
  const translated = new Set<string>()
  const reviewControllers = new Map<SessionId, AbortController>()
  const lifetime = new AbortController()

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-language-tutor disposed'))
    for (const controller of reviewControllers.values()) controller.abort()
    reviewControllers.clear()
    reviewQueues.clear()
  }, 'dsh-language-tutor: runtime lifecycle')

  const llmText = (
    route: ModelRoute,
    prompt: string,
    sessionId: SessionId,
    maxTokens: number,
    signal: AbortSignal = lifetime.signal,
  ): Promise<string> => runAuxiliaryLlm(ctx, {
    route,
    prompt,
    sessionId,
    signal,
    maxTokens,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
  })

  const runReview = async (
    agent: Agent,
    message: Message,
    proposed: LlmCallConfig,
    controller: AbortController,
  ): Promise<void> => {
    const current = settings.get()
    const text = textOf(message)
    if (current.check === 'off' || shouldSkipCheck(text)) return
    const cardId = `review:${message.id}`
    if (reviewed.has(cardId) || hasCard(agent.session, cardId)) return
    reviewed.add(cardId)
    const route = current.route ?? { provider: proposed.provider, model: proposed.model }
    try {
      const context = current.check === 'context' ? contextExcerpt(agent.session, message.id) : undefined
      const raw = await llmText(
        route,
        buildReviewPrompt(text, current, context),
        agent.id,
        config.reviewMaxOutputTokens,
        controller.signal,
      )
      if (controller.signal.aborted) return
      const parsed = parseReviewResult(raw)
      if (parsed === undefined || parsed.mode === 'skip') return
      if (parsed.mode === 'check') {
        if (parsed.items.length === 0 && parsed.rephrase === null) return
        appendCard(agent.session, cardId, 'start', {
          kind: 'review',
          mode: 'check',
          learning: current.learning,
          native: current.native,
          items: parsed.items,
          ...parsed.rephrase === null ? {} : { rephrase: parsed.rephrase },
          addedCards: 0,
        })
        return
      }
      if (!current.tutor) return
      const addedCards = flashcards.addTutorWords(parsed.tutor.words)
      appendCard(agent.session, cardId, 'start', {
        kind: 'review',
        mode: 'tutor',
        learning: current.learning,
        native: current.native,
        tutor: parsed.tutor,
        addedCards,
      })
    } catch (error) {
      if (!controller.signal.aborted) ctx.logger.warn(`dsh-language-tutor: review failed: ${safeError(error)}`)
    } finally {
      if (reviewControllers.get(agent.id) === controller) reviewControllers.delete(agent.id)
    }
  }

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const proposed = await next()
    const message = currentHumanMessage(agent, turn, step)
    if (message === undefined) return proposed
    const current = settings.get()
    const text = textOf(message)
    if (current.check === 'off' || shouldSkipCheck(text)) return proposed
    reviewControllers.get(agent.id)?.abort(new Error('superseded by a newer prompt'))
    const controller = new AbortController()
    reviewControllers.set(agent.id, controller)
    void runReview(agent, message, proposed, controller)
    return proposed
  })

  const translate = async (
    session: Session,
    source: { readonly event: SessionEvent<'assistant/message'>; readonly text: string },
    signal?: AbortSignal,
  ): Promise<number> => {
    const current = settings.get()
    const message = source.event.data.message
    const route = current.route ?? routeOf(message) ?? (() => {
      const header = session.requestHeader()?.config
      return header === undefined ? undefined : { provider: header.provider, model: header.model }
    })()
    if (route === undefined) throw new Error('no model route is available; set one with /lang model <provider/model>')
    const clipped = source.text.slice(0, MAX_TRANSLATE_CHARS)
    const cardId = `translation:${message.id}:${crypto.randomUUID()}`
    appendCard(session, cardId, 'start', { kind: 'translation', native: current.native, status: 'loading' })

    const translateTexts = async (texts: readonly string[], context?: string): Promise<string[]> => {
      const budget = translationTokenBudget(texts, config.translationMaxOutputTokens)
      let hitOutputLimit = false
      try {
        const raw = await llmText(
          route,
          buildSegmentTranslationPrompt(texts, current, context),
          session.id,
          budget,
          signal,
        )
        const values = parseSegmentTranslations(raw, texts.length)
        if (values !== undefined) return values
      } catch (error) {
        if (!(error instanceof AuxiliaryLlmError) || error.code !== 'MAX_TOKENS') throw error
        hitOutputLimit = true
      }

      if (texts.length > 1) {
        const middle = Math.ceil(texts.length / 2)
        const left = await translateTexts(texts.slice(0, middle), context)
        const right = await translateTexts(texts.slice(middle), context)
        return [...left, ...right]
      }

      const text = texts[0] ?? ''
      if (hitOutputLimit && text.length > 400) {
        const parts = splitTranslationText(text, Math.max(200, Math.ceil(text.length / 2)))
        if (parts.length > 1) return [(await translateTexts(parts, context)).join('\n\n')]
      }

      try {
        return [await llmText(
          route,
          buildWholeTranslationPrompt(text, current, context),
          session.id,
          translationTokenBudget([text], config.translationMaxOutputTokens),
          signal,
        )]
      } catch (error) {
        if (!(error instanceof AuxiliaryLlmError) || error.code !== 'MAX_TOKENS' || text.length <= 400) throw error
        const parts = splitTranslationText(text, Math.max(200, Math.ceil(text.length / 2)))
        if (parts.length <= 1) throw error
        return [(await translateTexts(parts, context)).join('\n\n')]
      }
    }

    const attempt = async (context?: string): Promise<TranslationCard> => {
      const markdown = segmentMarkdown(clipped)
      const prose = markdown.flatMap(segment => segment.kind === 'prose' ? [segment.text] : [])
      if (prose.length > 0) {
        const pieces = translationPieces(prose)
        const translatedPieces: string[] = []
        for (const batch of translationBatches(pieces)) {
          translatedPieces.push(...await translateTexts(batch.map(piece => piece.text), context))
        }
        const bySegment = Array.from({ length: prose.length }, () => [] as string[])
        pieces.forEach((piece, index) => bySegment[piece.segmentIndex]?.push(translatedPieces[index] ?? ''))
        const translations = bySegment.map(parts => parts.join('\n\n'))
        const segments = assembleTranslationSegments(markdown, translations)
        if (segments !== undefined) {
          return { kind: 'translation', native: current.native, status: 'done', segments }
        }
      }
      const text = await llmText(
        route,
        buildWholeTranslationPrompt(clipped, current, context),
        session.id,
        config.translationMaxOutputTokens,
        signal,
      )
      return { kind: 'translation', native: current.native, status: 'done', text }
    }

    try {
      const context = current.context ? contextExcerpt(session, message.id) : undefined
      let card: TranslationCard
      try {
        card = await attempt(context)
      } catch (error) {
        if (context === undefined || signal?.aborted === true) throw error
        ctx.logger.warn(`dsh-language-tutor: contextual translation failed, retrying without context: ${safeError(error)}`)
        card = await attempt(undefined)
      }
      return appendCard(session, cardId, 'update', card)
    } catch (error) {
      appendCard(session, cardId, 'update', {
        kind: 'translation',
        native: current.native,
        status: 'error',
        error: safeError(error),
      })
      throw error
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' || event.data.interrupted === true) return
    const current = settings.get()
    if (!current.auto) return
    const text = textOf(event.data.message)
    if (contentUnits(text) < MIN_AUTO_UNITS || event.data.message.content.some(block => block.type === 'tool-call')) return
    const key = `auto:${session.id}:${event.data.message.id}`
    if (translated.has(key)) return
    translated.add(key)
    void translate(session, { event, text }).catch((error: unknown) => {
      ctx.logger.warn(`dsh-language-tutor: automatic translation failed: ${safeError(error)}`)
    })
  })

  ctx.commands.register({
    name: 'translate',
    description: 'Translate the latest assistant response into your native language',
    input: { hint: '[assistant-message-id]' },
    handler: async ({ agent, rawInput, signal }): Promise<CommandResult> => {
      const messageId = rawInput.trim()
      const source = messageId.length === 0
        ? lastAssistant(agent.session)
        : assistantById(agent.session, messageId)
      if (source === undefined) return resultError('No assistant response is available to translate.')
      try {
        const sourceEventSeq = await translate(agent.session, source, signal)
        return { kind: 'success', sourceEventSeq }
      } catch (error) {
        return resultError(`Translation failed: ${safeError(error)}`)
      }
    },
  })

  const flashcardMessage = (session: Session, message: string): number => appendCard(
    session,
    `flashcards:${crypto.randomUUID()}`,
    'start',
    { kind: 'flashcard', stage: 'empty', reviewId: crypto.randomUUID(), remaining: 0, message },
  )

  const dealNext = (session: Session, queue: ReviewQueue): number => {
    const cardId = queue.queue[0]
    if (cardId === undefined) {
      delete queue.current
      return flashcardMessage(session, '本轮复习完成。再次运行 /flashcards 可开始新一轮。')
    }
    const card = flashcards.all().find(entry => entry.id === cardId)
    if (card === undefined) {
      queue.queue.shift()
      return dealNext(session, queue)
    }
    const reviewId = crypto.randomUUID()
    queue.current = { reviewId, cardId, revealed: false }
    const data: FlashcardCard = {
      kind: 'flashcard',
      stage: 'question',
      reviewId,
      cardId,
      word: card.word,
      remaining: queue.queue.length,
    }
    return appendCard(session, reviewId, 'start', data)
  }

  ctx.commands.register({
    name: 'flashcards',
    description: 'Review, add, or inspect language-tutor flashcards',
    input: { hint: '[show <review-id> | rate <review-id> <again|hard|good|easy> | add <word> :: <note> | stats | stop]' },
    handler: ({ agent, rawInput }): CommandResult => {
      const input = rawInput.trim()
      const [action = '', ...parts] = input.split(/\s+/u)
      if (action === 'stats') {
        const stats = flashcards.stats(config.flashcardNewPerDay)
        const next = stats.nextDue === null ? 'none scheduled' : stats.nextDue
        const sourceEventSeq = flashcardMessage(agent.session,
          `卡片 ${stats.total} 张；当前可复习 ${stats.due} 张；其中新卡 ${stats.newCards} 张；下次到期：${next}`)
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'add') {
        const body = input.slice(action.length).trim()
        const separator = body.indexOf('::')
        if (separator < 1) return resultError('Use /flashcards add <word or phrase> :: <note>.')
        const word = body.slice(0, separator).trim()
        const note = body.slice(separator + 2).trim()
        const added = flashcards.add(word, note, 'manual')
        const sourceEventSeq = flashcardMessage(agent.session,
          added ? `已加入卡片：${word}` : '没有加入：卡片已存在，或正反面有一项为空。')
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'stop') {
        reviewQueues.delete(agent.id)
        const sourceEventSeq = flashcardMessage(agent.session, '复习已停止。')
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'show') {
        const queue = reviewQueues.get(agent.id)
        const current = queue?.current
        if (queue === undefined || current === undefined || parts[0] !== current.reviewId) {
          return resultError('This review card is no longer active.')
        }
        const card = flashcards.all().find(entry => entry.id === current.cardId)
        if (card === undefined) return resultError('The flashcard no longer exists.')
        current.revealed = true
        const sourceEventSeq = appendCard(agent.session, current.reviewId, 'update', {
          kind: 'flashcard',
          stage: 'answer',
          reviewId: current.reviewId,
          cardId: card.id,
          word: card.word,
          note: card.note,
          remaining: queue.queue.length,
        })
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'rate') {
        const queue = reviewQueues.get(agent.id)
        const current = queue?.current
        const grade = gradeFrom(parts[1] ?? '')
        if (queue === undefined || current === undefined || parts[0] !== current.reviewId) {
          return resultError('This review card is no longer active.')
        }
        if (!current.revealed) return resultError('Show the answer before rating the card.')
        if (grade === undefined) return resultError('Rating must be again, hard, good, or easy.')
        const entry = flashcards.rate(current.cardId, grade)
        if (entry === undefined) return resultError('The flashcard no longer exists.')
        queue.queue.shift()
        if (isRetryGrade(grade)) queue.queue.push(entry.id)
        appendCard(agent.session, current.reviewId, 'update', {
          kind: 'flashcard',
          stage: 'rated',
          reviewId: current.reviewId,
          cardId: entry.id,
          word: entry.word,
          rating: grade,
          nextDue: new Date(entry.fsrs.due).toISOString(),
          remaining: queue.queue.length,
        })
        delete queue.current
        const sourceEventSeq = dealNext(agent.session, queue)
        return { kind: 'success', sourceEventSeq }
      }
      if (input.length > 0) {
        return resultError('Unknown flashcards action. Try /flashcards, /flashcards stats, or /flashcards add <word> :: <note>.')
      }
      const due = flashcards.due(config.flashcardSessionLimit, config.flashcardNewPerDay)
      if (due.length === 0) {
        const sourceEventSeq = flashcardMessage(agent.session, '现在没有到期卡片。可用 /flashcards add <word> :: <note> 手动添加。')
        return { kind: 'success', sourceEventSeq }
      }
      const queue: ReviewQueue = { queue: due.map(entry => entry.id) }
      reviewQueues.set(agent.id, queue)
      const sourceEventSeq = dealNext(agent.session, queue)
      return { kind: 'success', sourceEventSeq }
    },
  })

  ctx.commands.register({
    name: 'lang',
    description: 'Show or change language-tutor settings',
    input: { hint: '[check|tutor|auto|native|learning|model|context] [value]' },
    handler: ({ rawInput }): CommandResult => {
      const input = rawInput.trim()
      if (input.length === 0) return { kind: 'success', text: settingsText(settings.get()) }
      const [key = '', ...rest] = input.split(/\s+/u)
      const value = rest.join(' ').trim()
      if (key === 'on' || key === 'off') {
        settings.update({ check: key === 'on' ? 'on' : 'off' })
        return { kind: 'success', text: settingsText(settings.get()) }
      }
      if (key === 'check') {
        if (value !== 'off' && value !== 'on' && value !== 'context') {
          return resultError('check must be off, on, or context.')
        }
        if (value === 'off') {
          for (const controller of reviewControllers.values()) controller.abort(new Error('writing check disabled'))
          reviewControllers.clear()
        }
        settings.update({ check: value })
        return { kind: 'success', text: settingsText(settings.get()) }
      }
      if (key === 'tutor' || key === 'auto' || key === 'context') {
        const enabled = boolValue(value)
        if (enabled === undefined) return resultError(`${key} must be on or off.`)
        settings.update({ [key]: enabled })
        return { kind: 'success', text: settingsText(settings.get()) }
      }
      if (key === 'native' || key === 'learning') {
        if (value.length === 0) return resultError(`${key} needs a language code, for example zh-CN or en.`)
        settings.update({ [key]: value })
        return { kind: 'success', text: settingsText(settings.get()) }
      }
      if (key === 'model') {
        if (value === 'default') {
          settings.update({ route: undefined })
          return { kind: 'success', text: settingsText(settings.get()) }
        }
        const route = parseModelRoute(value)
        if (route === undefined) return resultError('Use /lang model <provider/model>, or /lang model default.')
        settings.update({ route })
        return { kind: 'success', text: settingsText(settings.get()) }
      }
      return resultError(`Unknown setting "${key}". Run /lang to see the available settings.`)
    },
  })
}

export type { FlashcardEntry, TutorSettings } from './types.js'
export {
  assembleTranslationSegments,
  batchTranslationTexts,
  buildReviewPrompt,
  buildSegmentTranslationPrompt,
  buildWholeTranslationPrompt,
  normalizeSettings,
  parseReviewResult,
  segmentMarkdown,
  shouldSkipCheck,
  splitTranslationText,
} from './core.js'
