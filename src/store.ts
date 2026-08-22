import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createEmptyCard, fsrs, Rating, type Grade } from 'ts-fsrs'
import { DEFAULT_SETTINGS, normalizeSettings } from './core.js'
import type { FlashcardEntry, TutorSettings, TutorWord } from './types.js'

export { Rating }
export type { Grade }

type SettingsPatch = Omit<Partial<TutorSettings>, 'route'> & { route?: TutorSettings['route'] | undefined }

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

export class SettingsStore {
  private value: TutorSettings

  constructor(
    private readonly path: string,
    defaults: TutorSettings = DEFAULT_SETTINGS,
  ) {
    const persisted = readJson(path)
    this.value = persisted === undefined
      ? normalizeSettings(defaults)
      : normalizeSettings(persisted, DEFAULT_SETTINGS)
  }

  get(): TutorSettings {
    return this.value
  }

  replace(value: TutorSettings): TutorSettings {
    this.value = normalizeSettings(value, this.value)
    writeJsonAtomic(this.path, this.value)
    return this.value
  }

  update(patch: SettingsPatch): TutorSettings {
    const routePatch = Object.prototype.hasOwnProperty.call(patch, 'route')
      ? { route: patch.route }
      : {}
    const next = {
      ...this.value,
      ...patch,
      ...routePatch,
    } as TutorSettings
    this.value = normalizeSettings(next, this.value)
    if (Object.prototype.hasOwnProperty.call(patch, 'route') && patch.route === undefined) {
      const { route: _route, ...withoutRoute } = this.value
      this.value = Object.freeze(withoutRoute)
    }
    writeJsonAtomic(this.path, this.value)
    return this.value
  }
}

export interface FlashcardPreferences {
  readonly sessionLimit: number
  readonly newPerDay: number
}

type FlashcardPreferencesPatch = Partial<FlashcardPreferences>

export const MAX_FLASHCARD_REVIEW_LIMIT = 200

function boundedInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(MAX_FLASHCARD_REVIEW_LIMIT, Math.max(minimum, value))
    : fallback
}

function normalizeFlashcardPreferences(
  value: unknown,
  fallback: FlashcardPreferences,
): FlashcardPreferences {
  const input = typeof value === 'object' && value !== null
    ? value as Partial<FlashcardPreferences>
    : {}
  return Object.freeze({
    sessionLimit: boundedInteger(input.sessionLimit, fallback.sessionLimit, 1),
    newPerDay: boundedInteger(input.newPerDay, fallback.newPerDay, 0),
  })
}

export class FlashcardPreferencesStore {
  private value: FlashcardPreferences

  constructor(
    private readonly path: string,
    defaults: FlashcardPreferences,
  ) {
    const normalizedDefaults = normalizeFlashcardPreferences(defaults, { sessionLimit: 20, newPerDay: 10 })
    this.value = normalizeFlashcardPreferences(readJson(path), normalizedDefaults)
  }

  get(): FlashcardPreferences {
    return this.value
  }

  update(patch: FlashcardPreferencesPatch): FlashcardPreferences {
    this.value = normalizeFlashcardPreferences({ ...this.value, ...patch }, this.value)
    writeJsonAtomic(this.path, this.value)
    return this.value
  }
}

function reviveEntry(value: unknown): FlashcardEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Partial<FlashcardEntry>
  if (typeof row.id !== 'string' || typeof row.word !== 'string' || typeof row.note !== 'string'
    || typeof row.createdAt !== 'string' || (row.source !== 'tutor' && row.source !== 'manual')
    || typeof row.fsrs !== 'object' || row.fsrs === null) return undefined
  const card = { ...row.fsrs }
  if (card.due !== undefined) card.due = new Date(card.due as unknown as string)
  if (card.last_review !== undefined) card.last_review = new Date(card.last_review as unknown as string)
  return {
    id: row.id,
    word: row.word,
    note: row.note,
    source: row.source,
    createdAt: row.createdAt,
    ...typeof row.introducedAt === 'string' ? { introducedAt: row.introducedAt } : {},
    fsrs: card,
  }
}

function loadEntries(path: string): FlashcardEntry[] {
  const value = readJson(path)
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { cards?: unknown }).cards)
      ? (value as { cards: unknown[] }).cards
      : []
  return rows.flatMap(row => {
    const entry = reviveEntry(row)
    return entry === undefined ? [] : [entry]
  })
}

function normalizedWord(word: string): string {
  return word.trim().toLocaleLowerCase()
}

function isDue(entry: FlashcardEntry, now: Date): boolean {
  return entry.fsrs.state === 0 || new Date(entry.fsrs.due) <= now
}

function introducedToday(entries: readonly FlashcardEntry[], now: Date): number {
  const today = now.toDateString()
  return entries.filter(entry => entry.introducedAt !== undefined
    && new Date(entry.introducedAt).toDateString() === today).length
}

export interface FlashcardStats {
  readonly total: number
  readonly due: number
  readonly newCards: number
  readonly nextDue: string | null
}

export class FlashcardStore {
  private entries: FlashcardEntry[]
  private readonly scheduler

  constructor(
    private readonly path: string,
    requestRetention: number,
  ) {
    this.entries = loadEntries(path)
    this.scheduler = fsrs({ enable_short_term: false, request_retention: requestRetention })
  }

  all(): readonly FlashcardEntry[] {
    return this.entries
  }

  find(id: string): FlashcardEntry | undefined {
    return this.entries.find(entry => entry.id === id)
  }

  add(word: string, note: string, source: 'tutor' | 'manual' = 'tutor'): boolean {
    const key = normalizedWord(word)
    const cleanNote = note.trim()
    if (key.length === 0 || cleanNote.length === 0) return false
    if (this.entries.some(entry => normalizedWord(entry.word) === key)) return false
    this.entries.push({
      id: crypto.randomUUID(),
      word: word.trim(),
      note: cleanNote,
      source,
      createdAt: new Date().toISOString(),
      fsrs: createEmptyCard(),
    })
    this.save()
    return true
  }

  addTutorWords(words: readonly TutorWord[]): number {
    let added = 0
    for (const item of words) {
      const key = normalizedWord(item.word)
      if (key.length === 0 || item.note.trim().length === 0) continue
      if (this.entries.some(entry => normalizedWord(entry.word) === key)) continue
      this.entries.push({
        id: crypto.randomUUID(),
        word: item.word.trim(),
        note: item.note.trim(),
        source: 'tutor',
        createdAt: new Date().toISOString(),
        fsrs: createEmptyCard(),
      })
      added += 1
    }
    if (added > 0) this.save()
    return added
  }

  update(id: string, word: string, note: string): FlashcardEntry | undefined {
    const entry = this.find(id)
    const key = normalizedWord(word)
    const cleanNote = note.trim()
    if (entry === undefined || key.length === 0 || cleanNote.length === 0) return undefined
    if (this.entries.some(candidate => candidate.id !== id && normalizedWord(candidate.word) === key)) return undefined
    entry.word = word.trim()
    entry.note = cleanNote
    this.save()
    return entry
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex(entry => entry.id === id)
    if (index < 0) return false
    this.entries.splice(index, 1)
    this.save()
    return true
  }

  due(limit: number, newPerDay: number, now = new Date()): FlashcardEntry[] {
    const newBudget = Math.max(0, newPerDay - introducedToday(this.entries, now))
    let newTaken = 0
    return [...this.entries]
      .sort((left, right) => {
        if (left.fsrs.state === 0 && right.fsrs.state !== 0) return -1
        if (right.fsrs.state === 0 && left.fsrs.state !== 0) return 1
        return new Date(left.fsrs.due).getTime() - new Date(right.fsrs.due).getTime()
      })
      .filter((entry) => {
        if (!isDue(entry, now)) return false
        if (entry.fsrs.state !== 0) return true
        if (newTaken >= newBudget) return false
        newTaken += 1
        return true
      })
      .slice(0, Math.max(1, limit))
  }

  rate(id: string, grade: Grade, now = new Date()): FlashcardEntry | undefined {
    const entry = this.entries.find(candidate => candidate.id === id)
    if (entry === undefined) return undefined
    if (entry.fsrs.state === 0 && entry.introducedAt === undefined) entry.introducedAt = now.toISOString()
    entry.fsrs = this.scheduler.next(entry.fsrs, now, grade).card
    this.save()
    return entry
  }

  stats(newPerDay: number, now = new Date()): FlashcardStats {
    const newCards = this.entries.filter(entry => entry.fsrs.state === 0).length
    const reviewDue = this.entries.filter(entry => entry.fsrs.state !== 0 && isDue(entry, now)).length
    const budget = Math.max(0, newPerDay - introducedToday(this.entries, now))
    const next = this.entries
      .filter(entry => entry.fsrs.state !== 0 && !isDue(entry, now))
      .map(entry => new Date(entry.fsrs.due))
      .sort((left, right) => left.getTime() - right.getTime())[0]
    return {
      total: this.entries.length,
      due: reviewDue + Math.min(newCards, budget),
      newCards,
      nextDue: next?.toISOString() ?? null,
    }
  }

  private save(): void {
    writeJsonAtomic(this.path, { version: 1, cards: this.entries })
  }
}

export function isRetryGrade(grade: Grade): boolean {
  return grade === Rating.Again || grade === Rating.Hard
}
