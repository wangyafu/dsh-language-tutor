import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assembleTranslationSegments,
  batchTranslationTexts,
  buildReviewPrompt,
  buildSegmentTranslationPrompt,
  contentUnits,
  normalizeSettings,
  parseModelRoute,
  parseReviewResult,
  parseSegmentTranslationResult,
  parseWholeTranslationResult,
  segmentMarkdown,
  shouldSkipCheck,
  splitTranslationText,
} from '../src/core.js'

describe('settings and prompt screening', () => {
  it('normalizes persisted settings and keeps a complete route only', () => {
    assert.deepEqual(normalizeSettings({ learning: 'fr', native: 'ja', check: 'context', route: {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    } }), {
      learning: 'fr', native: 'ja', check: 'context', tutor: true, auto: false, context: false,
      route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    assert.equal(normalizeSettings({ route: { provider: 'only-one-field' } }).route, undefined)
  })

  it('parses provider/model without breaking model ids that contain slashes', () => {
    assert.deepEqual(parseModelRoute('openrouter/anthropic/claude-sonnet'), {
      provider: 'openrouter', model: 'anthropic/claude-sonnet',
    })
    assert.equal(parseModelRoute('missing-slash'), undefined)
  })

  it('skips commands, tiny fragments, and code-heavy prompts but accepts prose', () => {
    assert.equal(shouldSkipCheck('/translate'), true)
    assert.equal(shouldSkipCheck('please fix'), true)
    assert.equal(shouldSkipCheck('const answer = foo(bar);'), true)
    assert.equal(shouldSkipCheck('I want to understand why this implementation behaves differently.'), false)
    assert.equal(shouldSkipCheck('我想知道这个实现为什么会有不同的行为'), false)
    assert.equal(contentUnits('我想学英语'), 5)
  })

  it('includes bounded conversation context when requested', () => {
    const prompt = buildReviewPrompt('I has a question about this function.', normalizeSettings({}), 'assistant: earlier term')
    assert.match(prompt, /<context>/u)
    assert.match(prompt, /earlier term/u)
    assert.match(prompt, /<prompt>/u)
  })

  it('marks a replayed session prefix as full conversation context', () => {
    const prompt = buildReviewPrompt('I has a question about Sea Glass.', normalizeSettings({}), true)
    assert.match(prompt, /preceding conversation/u)
    assert.doesNotMatch(prompt, /<context>/u)
  })
})

describe('review response parsing', () => {
  it('parses check feedback and rejects unrelated JSON', () => {
    assert.deepEqual(
      parseReviewResult('{"mode":"check","items":[{"wrong":"has","right":"have","reason":"主谓一致"}],"rephrase":null}'),
      { mode: 'check', items: [{ wrong: 'has', right: 'have', reason: '主谓一致' }], rephrase: null },
    )
    assert.equal(parseReviewResult('{"status":"ok"}'), undefined)
  })

  it('caps tutor vocabulary and grammar', () => {
    const words = Array.from({ length: 8 }, (_, index) => ({ word: `word-${index}`, note: 'note' }))
    const grammar = Array.from({ length: 5 }, (_, index) => ({ structure: `g-${index}`, note: 'note' }))
    const parsed = parseReviewResult(JSON.stringify({ mode: 'tutor', sentence: 'A natural sentence.', words, grammar }))
    assert.equal(parsed?.mode, 'tutor')
    if (parsed?.mode === 'tutor') {
      assert.equal(parsed.tutor.words.length, 5)
      assert.equal(parsed.tutor.grammar.length, 3)
    }
  })
})

describe('bilingual segments', () => {
  it('asks the model to choose the opposite configured language', () => {
    const prompt = buildSegmentTranslationPrompt(
      ['这是一个中文回答。'],
      normalizeSettings({ learning: 'en', native: 'zh-CN' }),
    )
    assert.match(prompt, /predominantly zh-CN/u)
    assert.match(prompt, /translate it into en/u)
    assert.match(prompt, /predominantly en/u)
    assert.match(prompt, /translate it into zh-CN/u)
  })

  it('splits long prose near readable boundaries and packs bounded batches', () => {
    const source = Array.from({ length: 12 }, (_, index) =>
      `Sentence ${index + 1} explains one useful part of the translation batching behavior.`).join(' ')
    const pieces = splitTranslationText(source, 220)
    assert.ok(pieces.length > 1)
    assert.ok(pieces.every(piece => piece.length <= 220))

    const batches = batchTranslationTexts([
      'A'.repeat(180),
      'B'.repeat(180),
      'C'.repeat(180),
    ], 220)
    assert.ok(batches.length >= 3)
    assert.ok(batches.every(batch => batch.reduce((sum, text) => sum + text.length, 0) <= 220))
  })

  it('keeps short code and replaces long code with a reference', () => {
    const source = [
      'First paragraph.',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      'Second paragraph.',
      '',
      '```txt',
      '1', '2', '3', '4', '5', '6',
      '```',
    ].join('\n')
    const markdown = segmentMarkdown(source)
    assert.equal(markdown.filter(segment => segment.kind === 'prose').length, 2)
    assert.deepEqual(assembleTranslationSegments(markdown, ['第一段。', '第二段。']), [
      { kind: 'pair', source: 'First paragraph.', translation: '第一段。' },
      { kind: 'code', text: '```ts\nconst a = 1\n```' },
      { kind: 'pair', source: 'Second paragraph.', translation: '第二段。' },
      { kind: 'code-ref', lines: 6 },
    ])
  })

  it('switches native-language responses into the learning language', () => {
    const settings = normalizeSettings({ learning: 'en', native: 'zh-CN' })
    assert.deepEqual(parseSegmentTranslationResult(
      '{"sourceLanguage":"zh-CN","targetLanguage":"en","translations":["one","two"]}',
      2,
      settings,
    ), {
      direction: { source: 'zh-CN', target: 'en' },
      translations: ['one', 'two'],
    })
    assert.equal(parseSegmentTranslationResult(
      '{"sourceLanguage":"zh-CN","targetLanguage":"en","translations":["one"]}',
      2,
      settings,
    ), undefined)
  })

  it('switches learning-language responses into the native language', () => {
    const settings = normalizeSettings({ learning: 'en', native: 'zh-CN' })
    assert.deepEqual(parseWholeTranslationResult(
      '{"sourceLanguage":"en","targetLanguage":"zh-CN","translation":"你好"}',
      settings,
    ), {
      direction: { source: 'en', target: 'zh-CN' },
      translation: '你好',
    })
    assert.equal(parseWholeTranslationResult(
      '{"sourceLanguage":"en","targetLanguage":"en","translation":"hello"}',
      settings,
    ), undefined)
  })
})
