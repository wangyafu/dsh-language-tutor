import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DEFAULT_SETTINGS } from '../src/core.js'
import { FlashcardStore, Rating, SettingsStore } from '../src/store.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-language-tutor-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('persists changes and can return to the session model', () => {
    const path = join(temporaryRoot(), 'settings.json')
    const configuredDefaults = {
      ...DEFAULT_SETTINGS,
      route: { provider: 'deepseek-official', model: 'configured-default' },
    }
    const first = new SettingsStore(path, configuredDefaults)
    first.update({ native: 'ja', route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    assert.equal(new SettingsStore(path, configuredDefaults).get().route?.model, 'deepseek-v4-flash')
    first.update({ route: undefined })
    const restored = new SettingsStore(path, configuredDefaults).get()
    assert.equal(restored.native, 'ja')
    assert.equal(restored.route, undefined)
  })
})

describe('FlashcardStore', () => {
  it('deduplicates tutor words and persists their source', () => {
    const path = join(temporaryRoot(), 'flashcards.json')
    const cards = new FlashcardStore(path, 0.9)
    assert.equal(cards.addTutorWords([
      { word: 'refactor', note: '重构' },
      { word: 'Refactor', note: '重复项' },
    ]), 1)
    const restored = new FlashcardStore(path, 0.9).all()
    assert.equal(restored.length, 1)
    assert.deepEqual({ word: restored[0]?.word, note: restored[0]?.note, source: restored[0]?.source },
      { word: 'refactor', note: '重构', source: 'tutor' })
  })

  it('deals due cards and schedules a rated card', () => {
    const path = join(temporaryRoot(), 'flashcards.json')
    const cards = new FlashcardStore(path, 0.9)
    cards.add('idiomatic', '地道的', 'manual')
    const due = cards.due(20, 10, new Date('2026-08-21T00:00:00.000Z'))
    assert.equal(due.length, 1)
    const rated = cards.rate(due[0]!.id, Rating.Good, new Date('2026-08-21T00:00:00.000Z'))
    assert.equal(rated?.introducedAt, '2026-08-21T00:00:00.000Z')
    assert.notEqual(rated?.fsrs.state, 0)
    assert.equal(cards.stats(10, new Date('2026-08-21T00:00:00.000Z')).due, 0)
  })
})
