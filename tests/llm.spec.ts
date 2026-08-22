import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { runAuxiliaryLlm } from '../src/llm.js'

describe('contextual auxiliary LLM calls', () => {
  it('replays the captured agent prefix before the plugin prompt', async () => {
    let request: GenerateOptions | undefined
    const ctx = {
      llm: {
        stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          request = options
          return (async function* (): AsyncIterable<StreamChunk> {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"mode":"skip"}' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    } as unknown as Context
    const earlier = createUserMessage({
      content: [{ type: 'text', text: 'Use the project term Sea Glass.' }],
      source: { kind: 'user' },
    })

    const result = await runAuxiliaryLlm(ctx, {
      route: { provider: 'test', model: 'small' },
      prompt: 'Review the latest sentence.',
      maxTokens: 256,
      timeoutMs: 2_000,
      retries: 0,
      fork: {
        system: 'You are the project agent.',
        messages: [earlier],
        tools: [{ name: 'lookup', description: 'Look up a term', parameters: { type: 'object' } }],
        temperature: 0.2,
        stop: ['<done>'],
      },
    })

    assert.equal(result, '{"mode":"skip"}')
    assert.equal(request?.system, 'You are the project agent.')
    assert.equal(request?.messages.length, 2)
    assert.equal(request?.messages[0]?.id, earlier.id)
    assert.deepEqual(request?.tools?.map(tool => tool.name), ['lookup'])
    assert.equal(request?.temperature, 0.2)
    assert.deepEqual(request?.stop, ['<done>'])
  })
})
