import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isAgentLoopRequest, type GenerateOptions, type LlmCallConfig, type Message } from '@deepseek-ai/dsh-llm'
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
import { AuxiliaryLlmError, runAuxiliaryLlm, type AuxiliaryLlmFork } from './llm.js'
import {
  FlashcardPreferencesStore,
  FlashcardStore,
  isRetryGrade,
  MAX_FLASHCARD_REVIEW_LIMIT,
  Rating,
  SettingsStore,
} from './store.js'
import {
  LANGUAGE_TUTOR_EVENT,
  type FlashcardCard,
  type FlashcardEntry,
  type FlashcardLibraryItem,
  type LanguageTutorCard,
  type LanguageSettingsCard,
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
  reviewMaxOutputTokens: z.number().step(1).min(128).default(1_200),
  translationMaxOutputTokens: z.number().step(1).min(128).default(4_096),
  timeoutMs: z.number().step(1).min(1_000).default(30_000),
  retries: z.number().step(1).min(0).max(2).default(1),
  flashcardSessionLimit: z.number().step(1).min(1).max(MAX_FLASHCARD_REVIEW_LIMIT).default(20),
  flashcardNewPerDay: z.number().step(1).min(0).max(MAX_FLASHCARD_REVIEW_LIMIT).default(10),
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

interface SessionFork {
  readonly route: ModelRoute
  readonly request: AuxiliaryLlmFork
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
      1_200,
      128,
    ),
    translationMaxOutputTokens: integer(
      config.translationMaxOutputTokens,
      4_096,
      128,
    ),
    timeoutMs: integer(config.timeoutMs, 30_000, 1_000),
    retries: integer(config.retries, 1, 0, 2),
    flashcardSessionLimit: integer(config.flashcardSessionLimit, 20, 1, MAX_FLASHCARD_REVIEW_LIMIT),
    flashcardNewPerDay: integer(config.flashcardNewPerDay, 10, 0, MAX_FLASHCARD_REVIEW_LIMIT),
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

const FLASHCARD_LIBRARY_PAGE_SIZE = 8

function flashcardLibraryItem(entry: FlashcardEntry, now: Date): FlashcardLibraryItem {
  if (entry.fsrs.state === 0) {
    return { id: entry.id, word: entry.word, note: entry.note, source: entry.source, state: 'new' }
  }
  const due = new Date(entry.fsrs.due)
  return {
    id: entry.id,
    word: entry.word,
    note: entry.note,
    source: entry.source,
    state: due <= now ? 'due' : 'scheduled',
    due: due.toISOString(),
  }
}

function decodeCommandValue(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const home = resolveDshHome(config.dshHome)
  const root = join(home, 'state', 'dsh-language-tutor')
  const settings = new SettingsStore(join(root, 'settings.json'), config.initialSettings)
  const flashcards = new FlashcardStore(join(root, 'flashcards.json'), config.requestRetention)
  const flashcardPreferences = new FlashcardPreferencesStore(join(root, 'flashcard-settings.json'), {
    sessionLimit: config.flashcardSessionLimit,
    newPerDay: config.flashcardNewPerDay,
  })
  const reviewQueues = new Map<SessionId, ReviewQueue>()
  const reviewed = new Set<string>()
  const translated = new Set<string>()
  const reviewControllers = new Map<SessionId, AbortController>()
  const sessionForks = new Map<SessionId, SessionFork>()
  const lifetime = new AbortController()

  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (isAgentLoopRequest(options) && options.sessionId !== undefined) {
      sessionForks.set(options.sessionId, {
        route: { provider: options.provider, model: options.model },
        request: {
          messages: options.messages,
          ...options.system === undefined ? {} : { system: options.system },
          ...options.tools === undefined ? {} : { tools: options.tools },
          ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.stop === undefined ? {} : { stop: options.stop },
        },
      })
    }
    return next()
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('dsh-language-tutor disposed'))
    for (const controller of reviewControllers.values()) controller.abort()
    reviewControllers.clear()
    reviewQueues.clear()
    sessionForks.clear()
  }, 'dsh-language-tutor: runtime lifecycle')

  const llmText = (
    route: ModelRoute,
    prompt: string,
    sessionId: SessionId,
    maxTokens: number,
    signal: AbortSignal = lifetime.signal,
    fork?: AuxiliaryLlmFork,
  ): Promise<string> => runAuxiliaryLlm(ctx, {
    route,
    prompt,
    sessionId,
    signal,
    maxTokens,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    ...fork === undefined ? {} : { fork },
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
      const snapshot = current.check === 'context' ? sessionForks.get(agent.id) : undefined
      const excerpt = current.check === 'context' && snapshot === undefined
        ? contextExcerpt(agent.session, message.id)
        : undefined
      const attempt = async (fork?: AuxiliaryLlmFork) => parseReviewResult(await llmText(
        route,
        buildReviewPrompt(text, current, fork === undefined ? excerpt : true),
        agent.id,
        config.reviewMaxOutputTokens,
        controller.signal,
        fork,
      ))
      let parsed
      try {
        parsed = await attempt(snapshot?.request)
      } catch (error) {
        if (snapshot === undefined || controller.signal.aborted) throw error
        ctx.logger.warn(`dsh-language-tutor: contextual review failed, retrying without session fork: ${safeError(error)}`)
        parsed = await attempt(undefined)
      }
      if (parsed === undefined && snapshot !== undefined && !controller.signal.aborted) {
        parsed = await attempt(undefined)
      }
      if (controller.signal.aborted) return
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

    const translateTexts = async (
      texts: readonly string[],
      context?: string | true,
      fork?: AuxiliaryLlmFork,
    ): Promise<string[]> => {
      const budget = translationTokenBudget(texts, config.translationMaxOutputTokens)
      let hitOutputLimit = false
      try {
        const raw = await llmText(
          route,
          buildSegmentTranslationPrompt(texts, current, context),
          session.id,
          budget,
          signal,
          fork,
        )
        const values = parseSegmentTranslations(raw, texts.length)
        if (values !== undefined) return values
      } catch (error) {
        if (!(error instanceof AuxiliaryLlmError) || error.code !== 'MAX_TOKENS') throw error
        hitOutputLimit = true
      }

      if (texts.length > 1) {
        const middle = Math.ceil(texts.length / 2)
        const left = await translateTexts(texts.slice(0, middle), context, fork)
        const right = await translateTexts(texts.slice(middle), context, fork)
        return [...left, ...right]
      }

      const text = texts[0] ?? ''
      if (hitOutputLimit && text.length > 400) {
        const parts = splitTranslationText(text, Math.max(200, Math.ceil(text.length / 2)))
        if (parts.length > 1) return [(await translateTexts(parts, context, fork)).join('\n\n')]
      }

      try {
        return [await llmText(
          route,
          buildWholeTranslationPrompt(text, current, context),
          session.id,
          translationTokenBudget([text], config.translationMaxOutputTokens),
          signal,
          fork,
        )]
      } catch (error) {
        if (!(error instanceof AuxiliaryLlmError) || error.code !== 'MAX_TOKENS' || text.length <= 400) throw error
        const parts = splitTranslationText(text, Math.max(200, Math.ceil(text.length / 2)))
        if (parts.length <= 1) throw error
        return [(await translateTexts(parts, context, fork)).join('\n\n')]
      }
    }

    const attempt = async (context?: string | true, fork?: AuxiliaryLlmFork): Promise<TranslationCard> => {
      const markdown = segmentMarkdown(clipped)
      const prose = markdown.flatMap(segment => segment.kind === 'prose' ? [segment.text] : [])
      if (prose.length > 0) {
        const pieces = translationPieces(prose)
        const translatedPieces: string[] = []
        for (const batch of translationBatches(pieces)) {
          translatedPieces.push(...await translateTexts(batch.map(piece => piece.text), context, fork))
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
        fork,
      )
      return { kind: 'translation', native: current.native, status: 'done', text }
    }

    try {
      const snapshot = current.context ? sessionForks.get(session.id) : undefined
      const excerpt = current.context && snapshot === undefined ? contextExcerpt(session, message.id) : undefined
      const context = snapshot === undefined ? excerpt : true
      const hadContext = snapshot !== undefined || excerpt !== undefined
      let card: TranslationCard
      try {
        card = await attempt(context, snapshot?.request)
      } catch (error) {
        if (!hadContext || signal?.aborted === true) throw error
        ctx.logger.warn(`dsh-language-tutor: contextual translation failed, retrying without session fork: ${safeError(error)}`)
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

  const flashcardLibrary = (
    session: Session,
    libraryId: string,
    requestedPage: number,
    role: 'start' | 'update',
    message?: string,
  ): number => {
    const entries = [...flashcards.all()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const pageCount = Math.max(1, Math.ceil(entries.length / FLASHCARD_LIBRARY_PAGE_SIZE))
    const page = Math.min(pageCount, Math.max(1, requestedPage))
    const start = (page - 1) * FLASHCARD_LIBRARY_PAGE_SIZE
    const now = new Date()
    return appendCard(session, libraryId, role, {
      kind: 'flashcard',
      stage: 'library',
      reviewId: libraryId,
      remaining: 0,
      items: entries.slice(start, start + FLASHCARD_LIBRARY_PAGE_SIZE)
        .map(entry => flashcardLibraryItem(entry, now)),
      page,
      pageCount,
      total: entries.length,
      ...message === undefined ? {} : { message },
    })
  }

  const flashcardSettingsCard = (
    session: Session,
    settingsId: string,
    role: 'start' | 'update',
    message?: string,
  ): number => {
    const current = flashcardPreferences.get()
    return appendCard(session, settingsId, role, {
      kind: 'flashcard',
      stage: 'settings',
      reviewId: settingsId,
      remaining: 0,
      sessionLimit: current.sessionLimit,
      newPerDay: current.newPerDay,
      ...message === undefined ? {} : { message },
    })
  }

  const dealNext = (session: Session, queue: ReviewQueue): number => {
    const cardId = queue.queue[0]
    if (cardId === undefined) {
      delete queue.current
      return flashcardMessage(session, '本轮复习完成。再次运行 /flashcards 可开始新一轮。')
    }
    const card = flashcards.find(cardId)
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
    input: { hint: '[library | settings | add <word> :: <note> | edit <id> <word> :: <note> | delete <id> | stats | stop]' },
    handler: ({ agent, rawInput }): CommandResult => {
      const input = rawInput.trim()
      const [action = '', ...parts] = input.split(/\s+/u)
      if (action === 'stats') {
        const stats = flashcards.stats(flashcardPreferences.get().newPerDay)
        const next = stats.nextDue === null ? 'none scheduled' : stats.nextDue
        const sourceEventSeq = flashcardMessage(agent.session,
          `卡片 ${stats.total} 张；当前可复习 ${stats.due} 张；其中新卡 ${stats.newCards} 张；下次到期：${next}`)
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'library' || action === 'list') {
        const existingId = parts[0]?.startsWith('flashcards:library:') && hasCard(agent.session, parts[0])
          ? parts[0]
          : undefined
        const requestedPage = Number(existingId === undefined ? parts[0] : parts[1])
        const page = Number.isInteger(requestedPage) ? requestedPage : 1
        const libraryId = existingId ?? `flashcards:library:${crypto.randomUUID()}`
        const sourceEventSeq = flashcardLibrary(
          agent.session,
          libraryId,
          page,
          existingId === undefined ? 'start' : 'update',
        )
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'settings') {
        const existingId = parts[0]?.startsWith('flashcards:settings:') && hasCard(agent.session, parts[0])
          ? parts[0]
          : undefined
        const key = existingId === undefined ? parts[0] : parts[1]
        const rawValue = existingId === undefined ? parts[1] : parts[2]
        const settingsId = existingId ?? `flashcards:settings:${crypto.randomUUID()}`
        if (key === undefined) {
          const sourceEventSeq = flashcardSettingsCard(agent.session, settingsId, 'start')
          return { kind: 'success', sourceEventSeq }
        }
        const normalizedKey = key === 'session' ? 'sessionLimit' : key === 'new' ? 'newPerDay' : key
        if (normalizedKey !== 'sessionLimit' && normalizedKey !== 'newPerDay') {
          return resultError('Setting must be sessionLimit (or session) or newPerDay (or new).')
        }
        const value = Number(rawValue)
        const minimum = normalizedKey === 'sessionLimit' ? 1 : 0
        if (!Number.isInteger(value) || value < minimum || value > MAX_FLASHCARD_REVIEW_LIMIT) {
          return resultError(`${normalizedKey} must be an integer from ${minimum} to ${MAX_FLASHCARD_REVIEW_LIMIT}.`)
        }
        flashcardPreferences.update({ [normalizedKey]: value })
        const sourceEventSeq = flashcardSettingsCard(
          agent.session,
          settingsId,
          existingId === undefined ? 'start' : 'update',
          '学习参数已保存。',
        )
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
      if (action === 'update') {
        const [libraryId, cardId, rawPage, encodedWord, encodedNote] = parts
        if (libraryId === undefined || !libraryId.startsWith('flashcards:library:') || !hasCard(agent.session, libraryId)
          || cardId === undefined || encodedWord === undefined || encodedNote === undefined) {
          return resultError('This flashcard library is no longer active.')
        }
        const word = decodeCommandValue(encodedWord)
        const note = decodeCommandValue(encodedNote)
        if (word === undefined || note === undefined) return resultError('The edited flashcard could not be decoded.')
        if (flashcards.find(cardId) === undefined) return resultError('The flashcard no longer exists.')
        if (flashcards.update(cardId, word, note) === undefined) {
          return resultError('Word and note are required, and the word must not duplicate another card.')
        }
        const parsedPage = Number(rawPage)
        const page = Number.isInteger(parsedPage) ? parsedPage : 1
        const sourceEventSeq = flashcardLibrary(agent.session, libraryId, page, 'update', `已保存：${word.trim()}`)
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'edit') {
        const body = input.slice(action.length).trim()
        const separator = body.indexOf('::')
        const left = separator < 0 ? '' : body.slice(0, separator).trim()
        const [cardId, ...wordParts] = left.split(/\s+/u)
        const word = wordParts.join(' ').trim()
        const note = separator < 0 ? '' : body.slice(separator + 2).trim()
        if (cardId === undefined || word.length === 0 || note.length === 0) {
          return resultError('Use /flashcards edit <card-id> <word or phrase> :: <note>.')
        }
        if (flashcards.find(cardId) === undefined) return resultError('The flashcard does not exist.')
        const updated = flashcards.update(cardId, word, note)
        if (updated === undefined) return resultError('Another flashcard already uses that word or phrase.')
        const sourceEventSeq = flashcardMessage(agent.session, `已更新卡片：${updated.word}`)
        return { kind: 'success', sourceEventSeq }
      }
      if (action === 'delete') {
        const libraryId = parts[0]?.startsWith('flashcards:library:') && hasCard(agent.session, parts[0])
          ? parts[0]
          : undefined
        const cardId = libraryId === undefined ? parts[0] : parts[1]
        if (cardId === undefined) return resultError('Use /flashcards delete <card-id>.')
        const entry = flashcards.find(cardId)
        if (entry === undefined) return resultError('The flashcard does not exist.')
        flashcards.remove(cardId)
        for (const queue of reviewQueues.values()) {
          for (let index = queue.queue.length - 1; index >= 0; index -= 1) {
            if (queue.queue[index] === cardId) queue.queue.splice(index, 1)
          }
          if (queue.current?.cardId === cardId) delete queue.current
        }
        if (libraryId !== undefined) {
          const rawPage = Number(parts[2])
          const page = Number.isInteger(rawPage) ? rawPage : 1
          const sourceEventSeq = flashcardLibrary(agent.session, libraryId, page, 'update', `已删除：${entry.word}`)
          return { kind: 'success', sourceEventSeq }
        }
        const sourceEventSeq = flashcardMessage(agent.session, `已删除卡片：${entry.word}`)
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
        const card = flashcards.find(current.cardId)
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
        return resultError('Unknown flashcards action. Try /flashcards, /flashcards library, /flashcards settings, or /flashcards add <word> :: <note>.')
      }
      const preferences = flashcardPreferences.get()
      const due = flashcards.due(preferences.sessionLimit, preferences.newPerDay)
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
    handler: ({ agent, rawInput }): CommandResult => {
      const appendSettings = (
        settingsId: string,
        role: 'start' | 'update',
        message?: string,
      ): CommandResult => {
        const current = settings.get()
        const sessionConfig = agent.session.requestHeader()?.config
        const warning = (current.context || current.check === 'context') && current.route !== undefined
          && sessionConfig !== undefined
          && (current.route.provider !== sessionConfig.provider || current.route.model !== sessionConfig.model)
          ? `上下文模式会把完整会话前缀发送给 ${displayRoute(current.route)}；它与当前会话模型 ${sessionConfig.provider}/${sessionConfig.model} 不同，无法复用当前会话的提示缓存。`
          : undefined
        const card: LanguageSettingsCard = {
          kind: 'settings',
          settingsId,
          learning: current.learning,
          native: current.native,
          check: current.check,
          tutor: current.tutor,
          auto: current.auto,
          context: current.context,
          ...current.route === undefined ? {} : { route: current.route },
          ...message === undefined ? {} : { message },
          ...warning === undefined ? {} : { warning },
        }
        const sourceEventSeq = appendCard(agent.session, settingsId, role, card)
        const text = warning === undefined ? settingsText(current) : `${settingsText(current)}\n\nWarning: ${warning}`
        return { kind: 'success', text, sourceEventSeq }
      }

      const updateSetting = (key: string, value: string): string | undefined => {
        if (key === 'check') {
          if (value !== 'off' && value !== 'on' && value !== 'context') return 'check must be off, on, or context.'
          if (value === 'off') {
            for (const controller of reviewControllers.values()) controller.abort(new Error('writing check disabled'))
            reviewControllers.clear()
          }
          settings.update({ check: value })
          return undefined
        }
        if (key === 'tutor' || key === 'auto' || key === 'context') {
          const enabled = boolValue(value)
          if (enabled === undefined) return `${key} must be on or off.`
          settings.update({ [key]: enabled })
          return undefined
        }
        if (key === 'native' || key === 'learning') {
          if (value.length === 0) return `${key} needs a language code, for example zh-CN or en.`
          settings.update({ [key]: value })
          return undefined
        }
        if (key === 'model') {
          if (value === 'default') {
            settings.update({ route: undefined })
            return undefined
          }
          const route = parseModelRoute(value)
          if (route === undefined) return 'Use /lang model <provider/model>, or /lang model default.'
          settings.update({ route })
          return undefined
        }
        return `Unknown setting "${key}". Run /lang to see the available settings.`
      }

      const input = rawInput.trim()
      if (input.length === 0) {
        return appendSettings(`lang:settings:${crypto.randomUUID()}`, 'start')
      }
      const [key = '', ...rest] = input.split(/\s+/u)
      const value = rest.join(' ').trim()
      if (key === 'update') {
        const [settingsId, settingKey, encodedValue] = rest
        if (settingsId === undefined || !settingsId.startsWith('lang:settings:') || !hasCard(agent.session, settingsId)
          || settingKey === undefined || encodedValue === undefined) {
          return resultError('This language settings card is no longer active.')
        }
        const decodedValue = decodeCommandValue(encodedValue)
        if (decodedValue === undefined) return resultError('The setting value could not be decoded.')
        const error = updateSetting(settingKey, decodedValue.trim())
        if (error !== undefined) return resultError(error)
        return appendSettings(settingsId, 'update', '设置已保存。')
      }
      if (key === 'on' || key === 'off') {
        const error = updateSetting('check', key)
        if (error !== undefined) return resultError(error)
        return appendSettings(`lang:settings:${crypto.randomUUID()}`, 'start', '设置已保存。')
      }
      const error = updateSetting(key, value)
      if (error !== undefined) return resultError(error)
      return appendSettings(`lang:settings:${crypto.randomUUID()}`, 'start', '设置已保存。')
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
