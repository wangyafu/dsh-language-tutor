import type {
  CheckMode,
  GrammarItem,
  MarkdownSegment,
  ModelRoute,
  ReviewResult,
  TranslationSegment,
  TutorGrammar,
  TutorSettings,
  TutorWord,
} from './types.js'

export const MAX_CHECK_CHARS = 1_500
export const MAX_TRANSLATE_CHARS = 12_000
export const SHORT_CODE_LINES = 5
export const MIN_AUTO_UNITS = 15
export const TRANSLATION_BATCH_CHARS = 3_500

export const DEFAULT_SETTINGS: TutorSettings = Object.freeze({
  learning: 'en',
  native: 'zh-CN',
  check: 'on',
  tutor: true,
  auto: false,
  context: false,
})

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function normalizeSettings(value: unknown, fallback: TutorSettings = DEFAULT_SETTINGS): TutorSettings {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const check: CheckMode = raw.check === 'off' || raw.check === 'on' || raw.check === 'context'
    ? raw.check
    : fallback.check
  const provider = nonEmptyString(raw.provider)
  const model = nonEmptyString(raw.model)
  const nested = typeof raw.route === 'object' && raw.route !== null
    ? raw.route as Record<string, unknown>
    : undefined
  const nestedProvider = nonEmptyString(nested?.provider)
  const nestedModel = nonEmptyString(nested?.model)
  const route = provider !== undefined && model !== undefined
    ? { provider, model }
    : nestedProvider !== undefined && nestedModel !== undefined
      ? { provider: nestedProvider, model: nestedModel }
      : fallback.route
  return Object.freeze({
    learning: nonEmptyString(raw.learning) ?? fallback.learning,
    native: nonEmptyString(raw.native) ?? fallback.native,
    check,
    tutor: typeof raw.tutor === 'boolean' ? raw.tutor : fallback.tutor,
    auto: typeof raw.auto === 'boolean' ? raw.auto : fallback.auto,
    context: typeof raw.context === 'boolean' ? raw.context : fallback.context,
    ...route === undefined ? {} : { route: Object.freeze(route) },
  })
}

export function parseModelRoute(input: string): ModelRoute | undefined {
  const value = input.trim()
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  const provider = value.slice(0, slash).trim()
  const model = value.slice(slash + 1).trim()
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

/** Count Latin words and unspaced CJK characters on comparable footing. */
export function contentUnits(text: string): number {
  const latinWords = text.match(/[\p{L}\p{N}]+/gu)?.filter(token =>
    !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(token)).length ?? 0
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu)?.length ?? 0
  return Math.max(latinWords, cjk)
}

/** Reject commands, code-heavy prompts, and fragments too small to teach usefully. */
export function shouldSkipCheck(input: string): boolean {
  const text = input.trim()
  if (text.startsWith('/') || text.startsWith('!') || text.includes('```') || text.includes('~~~')) return true
  const compact = text.replace(/\s+/gu, '')
  if (compact.length === 0 || contentUnits(text) < 4) return true
  const letters = compact.match(/\p{L}/gu)?.length ?? 0
  if (letters / compact.length < 0.5) return true
  const tokens = text.split(/\s+/u).filter(Boolean)
  const codeLike = tokens.filter(token => /[{}()[\];=<>\\`$]|::|->|\.[a-z]{1,4}$|\//iu.test(token)).length
  return tokens.length > 0 && codeLike / tokens.length > 0.3
}

type PromptContext = string | true | undefined

function contextSection(context: PromptContext): string[] {
  if (context === true) {
    return [
      'Use the preceding conversation as context. Treat established names, identifiers, and terminology as intentional.',
      '',
    ]
  }
  if (context === undefined || context.trim().length === 0) return []
  return [
    'Recent conversation context follows. Treat established names and identifiers as intentional:',
    '<context>',
    context,
    '</context>',
    '',
  ]
}

export function buildReviewPrompt(text: string, settings: TutorSettings, context?: string | true): string {
  const tutorInstructions = settings.tutor
    ? [
        `If it is mainly not ${settings.learning}, use mode "tutor" and teach a natural ${settings.learning} sentence for the whole thought.`,
        `Return up to five useful words and three grammar structures; write every explanation in ${settings.native}.`,
        '{"mode":"tutor","sentence":"...","words":[{"word":"...","note":"..."}],"grammar":[{"structure":"...","note":"..."}]}',
      ]
    : [
        `If it is mainly not ${settings.learning}, return {"mode":"skip"}.`,
      ]
  return [
    ...contextSection(context),
    `You are checking a student's prompt. Their learning language is ${settings.learning}; their native language is ${settings.native}.`,
    'Reply with one JSON object only. Do not add a Markdown fence.',
    '',
    `If the prompt is mainly ${settings.learning}, use mode "check". Report at most five real spelling or grammar errors.`,
    `Keep wrong/right as short exact fragments. Explain reasons in ${settings.native}.`,
    'Give one rephrased sentence only when the original is understandable but noticeably unnatural; otherwise use null.',
    '{"mode":"check","items":[{"wrong":"...","right":"...","reason":"..."}],"rephrase":null}',
    '',
    ...tutorInstructions,
    '',
    'Ignore code, paths, commands, identifiers, product names, and project-specific terms. Do not manufacture errors.',
    'If the input is unclear or not useful as language practice, return {"mode":"skip"}.',
    '',
    '<prompt>',
    text.slice(0, MAX_CHECK_CHARS),
    '</prompt>',
  ].join('\n')
}

export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(raw.slice(start, end + 1))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function grammarItems(value: unknown): GrammarItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): GrammarItem[] => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as Record<string, unknown>
    const wrong = nonEmptyString(row.wrong)
    const right = nonEmptyString(row.right)
    if (wrong === undefined || right === undefined) return []
    return [{ wrong, right, reason: nonEmptyString(row.reason) ?? '' }]
  }).slice(0, 5)
}

function tutorWords(value: unknown): TutorWord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TutorWord[] => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as Record<string, unknown>
    const word = nonEmptyString(row.word)
    const note = nonEmptyString(row.note)
    return word === undefined || note === undefined ? [] : [{ word, note }]
  }).slice(0, 5)
}

function tutorGrammar(value: unknown): TutorGrammar[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TutorGrammar[] => {
    if (typeof item !== 'object' || item === null) return []
    const row = item as Record<string, unknown>
    const structure = nonEmptyString(row.structure)
    const note = nonEmptyString(row.note)
    return structure === undefined || note === undefined ? [] : [{ structure, note }]
  }).slice(0, 3)
}

export function parseReviewResult(raw: string): ReviewResult | undefined {
  const value = extractJsonObject(raw)
  if (value === undefined) return undefined
  if (value.mode === 'skip' || value.skip === true) return { mode: 'skip' }
  if (value.mode === 'tutor') {
    const sentence = nonEmptyString(value.sentence) ?? ''
    const words = tutorWords(value.words)
    const grammar = tutorGrammar(value.grammar)
    if (sentence.length === 0 && words.length === 0 && grammar.length === 0) return { mode: 'skip' }
    return { mode: 'tutor', tutor: { sentence, words, grammar } }
  }
  if (value.mode !== 'check' && !Array.isArray(value.items) && value.rephrase !== null
    && typeof value.rephrase !== 'string') return undefined
  return {
    mode: 'check',
    items: grammarItems(value.items),
    rephrase: value.rephrase === null ? null : nonEmptyString(value.rephrase) ?? null,
  }
}

export function segmentMarkdown(source: string): MarkdownSegment[] {
  const output: MarkdownSegment[] = []
  let prose: string[] = []
  let code: string[] = []
  let inCode = false
  const flushProse = (): void => {
    const paragraphs = prose.join('\n').split(/\n\s*\n/gu).map(value => value.trim()).filter(Boolean)
    output.push(...paragraphs.map(text => ({ kind: 'prose' as const, text })))
    prose = []
  }
  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      if (inCode) {
        code.push(line)
        output.push({ kind: 'code', text: code.join('\n'), lines: Math.max(0, code.length - 2) })
        code = []
      } else {
        flushProse()
        code.push(line)
      }
      inCode = !inCode
    } else if (inCode) code.push(line)
    else prose.push(line)
  }
  if (inCode) output.push({ kind: 'code', text: code.join('\n'), lines: Math.max(0, code.length - 1) })
  flushProse()
  return output
}

/** Split one long prose segment at a nearby paragraph, sentence, or word boundary. */
export function splitTranslationText(source: string, maxChars = TRANSLATION_BATCH_CHARS): string[] {
  const limit = Math.max(200, Math.floor(maxChars))
  const output: string[] = []
  let rest = source.trim()
  while (rest.length > limit) {
    const floor = Math.floor(limit * 0.55)
    const window = rest.slice(0, limit + 1)
    const candidates = [
      window.lastIndexOf('\n\n'),
      Math.max(...Array.from(window.matchAll(/[.!?。！？][\s\n]/gu), match => (match.index ?? -1) + 1), -1),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    ].filter(index => index >= floor)
    const cut = candidates.length > 0 ? Math.max(...candidates) : limit
    const part = rest.slice(0, cut).trim()
    if (part.length === 0) break
    output.push(part)
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) output.push(rest)
  return output
}

/** Pack already-split prose pieces into bounded auxiliary translation calls. */
export function batchTranslationTexts(
  texts: readonly string[],
  maxChars = TRANSLATION_BATCH_CHARS,
): string[][] {
  const limit = Math.max(200, Math.floor(maxChars))
  const output: string[][] = []
  let batch: string[] = []
  let length = 0
  const flush = (): void => {
    if (batch.length > 0) output.push(batch)
    batch = []
    length = 0
  }
  for (const source of texts) {
    for (const text of splitTranslationText(source, limit)) {
      const nextLength = length + text.length
      if (batch.length > 0 && nextLength > limit) flush()
      batch.push(text)
      length += text.length
    }
  }
  flush()
  return output
}

export function buildSegmentTranslationPrompt(
  prose: readonly string[],
  settings: TutorSettings,
  context?: string | true,
): string {
  return [
    ...contextSection(context),
    `Translate every numbered segment into ${settings.native}.`,
    'Keep inline code, paths, commands, identifiers, and technical names unchanged. Preserve Markdown inside each segment.',
    `Return JSON only in this shape: {"translations":[${prose.map(() => '"..."').join(',')}]}`,
    `The array must contain exactly ${prose.length} strings in the same order.`,
    '',
    ...prose.map((text, index) => `[${index}]\n${text}`),
  ].join('\n\n')
}

export function parseSegmentTranslations(raw: string, count: number): string[] | undefined {
  const values = extractJsonObject(raw)?.translations
  if (!Array.isArray(values) || values.length !== count || !values.every(value => typeof value === 'string')) {
    return undefined
  }
  return values.map(value => (value as string).trim())
}

export function buildWholeTranslationPrompt(source: string, settings: TutorSettings, context?: string | true): string {
  return [
    ...contextSection(context),
    `Translate the assistant response below into ${settings.native}.`,
    'Keep code blocks, inline code, paths, commands, and technical identifiers unchanged. Preserve Markdown.',
    'Return only the translation.',
    '',
    '<response>',
    source.slice(0, MAX_TRANSLATE_CHARS),
    '</response>',
  ].join('\n')
}

export function assembleTranslationSegments(
  markdown: readonly MarkdownSegment[],
  translations: readonly string[],
): TranslationSegment[] | undefined {
  const proseCount = markdown.filter(segment => segment.kind === 'prose').length
  if (proseCount !== translations.length) return undefined
  let index = 0
  return markdown.map((segment): TranslationSegment => {
    if (segment.kind === 'prose') {
      return { kind: 'pair', source: segment.text, translation: translations[index++] ?? '' }
    }
    return segment.lines <= SHORT_CODE_LINES
      ? { kind: 'code', text: segment.text }
      : { kind: 'code-ref', lines: segment.lines }
  })
}

export function displayRoute(route: ModelRoute | undefined): string {
  return route === undefined ? 'follow session' : `${route.provider}/${route.model}`
}
