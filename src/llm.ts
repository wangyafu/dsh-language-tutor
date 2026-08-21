import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  deepFreeze,
  type FinishReason,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelRoute } from './types.js'

export interface AuxiliaryLlmOptions {
  readonly route: ModelRoute
  readonly prompt: string
  readonly sessionId?: SessionId
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly retries: number
  readonly signal?: AbortSignal
}

export class AuxiliaryLlmError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AuxiliaryLlmError'
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('language tutor request aborted')
}

function combinedSignal(outer: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal
  readonly dispose: () => void
} {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(outer === undefined ? undefined : abortError(outer))
  if (outer?.aborted === true) onAbort()
  else outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new AuxiliaryLlmError(
    `language tutor request timed out after ${timeoutMs} ms`,
    'TIMEOUT',
  )), timeoutMs)
  timer.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onAbort)
    },
  }
}

function failureFromFinish(reason: FinishReason): AuxiliaryLlmError | undefined {
  if (reason.kind === 'stop') return undefined
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    return new AuxiliaryLlmError(reason.failure.message, reason.failure.code)
  }
  if (reason.kind === 'tool-calls') {
    return new AuxiliaryLlmError('auxiliary model returned a tool call', 'TOOL_CALL')
  }
  return new AuxiliaryLlmError('auxiliary model response hit its output limit', 'MAX_TOKENS')
}

const RETRYABLE_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'CONNECTION', 'EMPTY_RESPONSE'])

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function attempt(ctx: Context, options: AuxiliaryLlmOptions, signal: AbortSignal): Promise<string> {
  const message = createUserMessage({
    content: [{ type: 'text', text: options.prompt }],
    source: { kind: 'plugin', plugin: 'dsh-language-tutor' },
  })
  const request = deepFreeze<GenerateOptions>({
    provider: options.route.provider,
    model: options.route.model,
    messages: [message],
    maxTokens: options.maxTokens,
    signal,
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  const failure = failureFromFinish(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new AuxiliaryLlmError('auxiliary model returned a tool call', 'TOOL_CALL')
  }
  const text = blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) throw new AuxiliaryLlmError('auxiliary model returned no text', 'EMPTY_RESPONSE')
  return text
}

/** One-shot DSH LLM call with a deadline and a deliberately small retry budget. */
export async function runAuxiliaryLlm(ctx: Context, options: AuxiliaryLlmOptions): Promise<string> {
  const lifetime = combinedSignal(options.signal, options.timeoutMs)
  try {
    let lastError: unknown
    const retries = Math.max(0, Math.floor(options.retries))
    for (let index = 0; index <= retries; index += 1) {
      try {
        return await attempt(ctx, options, lifetime.signal)
      } catch (error) {
        lastError = error
        const code = error instanceof AuxiliaryLlmError ? error.code : ''
        if (index >= retries || !RETRYABLE_CODES.has(code) || lifetime.signal.aborted) throw error
        await wait(250 * (2 ** index), lifetime.signal)
      }
    }
    throw lastError
  } finally {
    lifetime.dispose()
  }
}
