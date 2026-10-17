import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodeBuddyAdapter, httpErrorCode } from '../src/adapter.js'
import type { CodeBuddyConnectionOptions } from '../src/adapter.js'
import { NotLoggedInError, SessionUnavailableError } from '../src/session.js'
import type { CodeBuddyModel } from '../src/types.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'

const identity: CodeBuddyIdentity = { accessToken: 'tok', domain: 'dom', uid: 'uid', site: 'cn' }

const DEFAULT_CONNECTION: CodeBuddyConnectionOptions = {
  defaultContextWindow: 128_000,
  defaultMaxTokens: 8_192,
  streamIdleTimeoutMs: 300_000,
}

/** A session double over the face the adapter reads. */
function sessionOf(over: {
  models?: readonly CodeBuddyModel[]
  identity?: () => Promise<CodeBuddyIdentity>
  invalidate?: () => void
} = {}) {
  return {
    identity: over.identity ?? (async () => identity),
    authHeaders: async () => ({ Authorization: `Bearer ${identity.accessToken}`, 'X-User-Id': 'uid' }),
    modelsOrEmpty: async () => over.models ?? [],
    invalidate: over.invalidate ?? (() => {}),
  }
}

function adapterOf(session: ReturnType<typeof sessionOf>, connection: CodeBuddyConnectionOptions = DEFAULT_CONNECTION) {
  return new CodeBuddyAdapter({
    session: session as never,
    options: () => connection,
    language: () => undefined,
  })
}

/** A model entry with both capacities disclosed, as the picker requires. */
function catalogEntry(over: Partial<CodeBuddyModel> & { id: string }): CodeBuddyModel {
  return { name: over.id, maxAllowedSize: 200_000, maxOutputTokens: 8_000, ...over }
}

/** An SSE response body whose payloads are the given JSON chunks plus [DONE]. */
function sseResponse(payloads: readonly (object | string)[], init: ResponseInit = {}): Response {
  const body = payloads.map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`).join('')
    + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

async function drain(adapter: CodeBuddyAdapter, options: Record<string, unknown>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options as never)) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('providerInfo', () => {
  it('reports the CodeBuddy display name under the route id', () => {
    expect(adapterOf(sessionOf()).providerInfo('codebuddy')).toEqual({ id: 'codebuddy', name: 'CodeBuddy' })
  })

  it('returns the configured retry policy, or nothing', () => {
    const policy = adapterOf(sessionOf(), { ...DEFAULT_CONNECTION, retryPolicy: { maxAttempts: 3 } as never })
    expect(policy.providerRetryPolicy('codebuddy')).toMatchObject({ maxAttempts: 3 })
    expect(adapterOf(sessionOf()).providerRetryPolicy('codebuddy')).toBeUndefined()
  })
})

describe('listModels', () => {
  it('offers only models with disclosed capacities', async () => {
    // CodeBuddy omits capacities on its non-chat models; offering them would
    // put unusable choices in the picker.
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'chat', credits: 'x1.00' }),
      { id: 'image', name: 'Image' },
      catalogEntry({ id: 'rewrite', maxAllowedSize: 0 }),
    ] }))
    expect((await adapter.listModels('codebuddy')).map(model => model.id)).toEqual(['chat'])
  })

  it('carries the credit rate as the description and declares image input', async () => {
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'vision', name: 'Vision', credits: 'x3.33', supportsImages: true }),
      catalogEntry({ id: 'plain', name: 'Plain', credits: '  ' }),
    ] }))
    const models = await adapter.listModels('codebuddy')
    expect(models[0]).toEqual({
      provider: 'codebuddy',
      id: 'vision',
      name: 'Vision',
      description: 'x3.33',
      inputModalities: ['text', 'image'],
    })
    // A blank credit label is not a description.
    expect(models[1]).not.toHaveProperty('description')
    expect(models[1]?.inputModalities).toEqual(['text'])
  })

  it('returns an empty list when the session cannot read a catalog', async () => {
    const adapter = adapterOf(sessionOf({ models: [] }))
    await expect(adapter.listModels('codebuddy')).resolves.toEqual([])
  })
})

describe('resolveModel', () => {
  it('sizes a listed model from the catalog', async () => {
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'big', maxAllowedSize: 400_000, maxOutputTokens: 16_000, supportsImages: true }),
    ] }))
    expect(await adapter.resolveModel('codebuddy', 'big')).toMatchObject({
      provider: 'codebuddy',
      id: 'big',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 400_000 },
      defaultMaxTokens: 16_000,
    })
  })

  it('falls back to the connection defaults for an unlisted id', async () => {
    // An unlisted id stays routable, but nothing is known about it, so the
    // conservative text-only shape is declared.
    const adapter = adapterOf(sessionOf({ models: [] }))
    expect(await adapter.resolveModel('codebuddy', 'ghost')).toEqual({
      provider: 'codebuddy',
      id: 'ghost',
      name: 'ghost',
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONNECTION.defaultContextWindow },
      defaultMaxTokens: DEFAULT_CONNECTION.defaultMaxTokens,
    })
  })

  it('falls back to the connection defaults when a listed entry withholds a size', async () => {
    const adapter = adapterOf(sessionOf({ models: [
      { id: 'unsized', name: 'Unsized' },
    ] }))
    expect(await adapter.resolveModel('codebuddy', 'unsized')).toMatchObject({
      context: { contextWindow: DEFAULT_CONNECTION.defaultContextWindow },
      defaultMaxTokens: DEFAULT_CONNECTION.defaultMaxTokens,
    })
  })

  it('declares reasoning only where the catalog supports it', async () => {
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'plain' }),
      catalogEntry({ id: 'thinker', reasoning: { supportedEfforts: ['low', 'high'] } }),
    ] }))
    expect(await adapter.resolveModel('codebuddy', 'plain')).not.toHaveProperty('reasoning')
    expect(await adapter.resolveModel('codebuddy', 'thinker')).toMatchObject({
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      },
    })
  })

  it('passes an unrecognized level through with a readable name', async () => {
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'm', reasoning: { supportedEfforts: ['turbo'] } }),
    ] }))
    expect(await adapter.resolveModel('codebuddy', 'm')).toMatchObject({
      reasoning: { efforts: [{ id: 'turbo', name: 'turbo' }], defaultEffort: 'turbo' },
    })
  })

  it('prefers the active level, then the declared default, as the default effort', async () => {
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'active', reasoning: { supportedEfforts: ['low', 'high'], effort: 'high', defaultEffort: 'low' } }),
    ] }))
    expect(await adapter.resolveModel('codebuddy', 'active')).toMatchObject({
      reasoning: { defaultEffort: 'high' },
    })
  })

  it('declares a single-level model that reasons without disclosing a list', async () => {
    // Declaring nothing would drop the level from every request and make the
    // harness reject a caller who named it.
    const adapter = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'always', supportsReasoning: true }),
    ] }))
    expect(await adapter.resolveModel('codebuddy', 'always')).not.toHaveProperty('reasoning')

    const withEffort = adapterOf(sessionOf({ models: [
      catalogEntry({ id: 'always', onlyReasoning: true, reasoning: { effort: 'max' } }),
    ] }))
    expect(await withEffort.resolveModel('codebuddy', 'always')).toMatchObject({
      reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' },
    })
  })
})

describe('httpErrorCode', () => {
  it('maps authentication refusals', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
  })

  it('maps the service quota codes before the status', () => {
    // 14018/14019 arrive on an otherwise ordinary status, so the code wins.
    expect(httpErrorCode(200, undefined, 14018)).toBe('QUOTA')
    expect(httpErrorCode(200, undefined, 14019)).toBe('QUOTA')
    expect(httpErrorCode(429, undefined, 14018)).toBe('QUOTA')
  })

  it('recognizes quota wording in the body', () => {
    expect(httpErrorCode(400, 'insufficient quota')).toBe('QUOTA')
  })

  it('maps a plain rate limit', () => {
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
  })

  it('distinguishes a context overflow from a generic bad request', () => {
    expect(httpErrorCode(400, 'maximum context length is 128000 tokens')).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(httpErrorCode(400)).toBe('INVALID_REQUEST')
  })

  it('maps server faults and unknown statuses', () => {
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(503)).toBe('SERVER')
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })
})

describe('stream — request construction', () => {
  it('posts to the credential site with the identity headers', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    await drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer tok',
      'X-User-Id': 'uid',
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': 'CodeBuddyIDE/4.12.0',
      'X-Model-ID': 'm',
    })
  })

  it('follows an explicit baseURL override and adds the conversation id', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = adapterOf(sessionOf(), { ...DEFAULT_CONNECTION, baseURL: 'https://proxy.example/v2' })
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [], sessionId: 'session-1' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://proxy.example/v2/chat/completions')
    expect(init.headers).toMatchObject({ 'X-Conversation-ID': 'session-1' })
  })

  it('uses the international host for an international credential', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const session = sessionOf({ identity: async () => ({ ...identity, site: 'intl' }) })
    await drain(adapterOf(session), { provider: 'codebuddy', model: 'm', messages: [] })
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://www.codebuddy.ai/v2/chat/completions')
  })

  it('streams the translated chunks back to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
    ])))
    const chunks = await drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] })
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => (chunk as { text: string }).text))
      .toEqual(['Hel', 'lo'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('refuses tool calls on a model that declared no tool support', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const adapter = adapterOf(sessionOf({ models: [catalogEntry({ id: 'chat', supportsToolCall: false })] }))
    await expect(drain(adapter, {
      provider: 'codebuddy',
      model: 'chat',
      messages: [],
      tools: [{ name: 'search', description: '', parameters: {} }],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the attachment service for a retained image', async () => {
    const adapter = new CodeBuddyAdapter({
      session: sessionOf({ models: [catalogEntry({ id: 'vision', supportsImages: true })] }) as never,
      options: () => DEFAULT_CONNECTION,
      resolveAttachments: () => undefined,
    })
    await expect(drain(adapter, {
      provider: 'codebuddy',
      model: 'vision',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: 'i', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as never }],
        source: { kind: 'user' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('stream — identity failures', () => {
  it('maps a signed-out session to the terminal credential code', async () => {
    const adapter = adapterOf(sessionOf({ identity: async () => { throw new NotLoggedInError('signed out') } }))
    await expect(drain(adapter, { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('maps an unreachable refresh to the retryable transport code', async () => {
    // The credential was never judged, so the harness must retry rather than
    // send a correctly-signed-in user through a login.
    const adapter = adapterOf(sessionOf({ identity: async () => { throw new SessionUnavailableError('offline') } }))
    await expect(drain(adapter, { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('propagates an unexpected identity failure unchanged', async () => {
    const adapter = adapterOf(sessionOf({ identity: async () => { throw new RangeError('bug') } }))
    await expect(drain(adapter, { provider: 'codebuddy', model: 'm', messages: [] })).rejects.toThrow('bug')
  })
})

describe('stream — HTTP failures', () => {
  it('reports the status, retry hint, and request id of a failure reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 11115, msg: 'slow down' }),
      { status: 429, headers: { 'retry-after': '2', 'x-request-id': 'req-42' } },
    )))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({
        code: 'RATE_LIMIT',
        failure: { status: 429, providerRetryAfterMs: 2_000, requestId: 'req-42', message: 'slow down' },
      })
  })

  it('accepts an HTTP-date retry hint', async () => {
    const when = new Date(Date.now() + 30_000).toUTCString()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503, headers: { 'retry-after': when } })))
    const error = await drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] })
      .catch((caught: unknown) => caught)
    expect((error as { code: string }).code).toBe('SERVER')
    const delay = (error as { failure: { providerRetryAfterMs: number } }).failure.providerRetryAfterMs
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(30_000)
  })

  it('reports the service wording in the language the client is displaying', async () => {
    const body = { code: 1, msg: 'raw', displayMsg: { en: 'English wording', zh: '中文说明', 'zh-hant': '繁體說明' } }
    const failing = (language: () => string | undefined) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })))
      return new CodeBuddyAdapter({
        session: sessionOf() as never,
        options: () => DEFAULT_CONNECTION,
        language,
      })
    }
    await expect(drain(failing(() => 'zh'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '中文说明' })
    await expect(drain(failing(() => 'zh-TW'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '繁體說明' })
    await expect(drain(failing(() => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'English wording' })
  })

  it('reports a regional Simplified Chinese client in Chinese, not English', async () => {
    // The service ships `zh`, never `zh-cn`, so a `zh-CN` client only reaches
    // the Chinese wording through the script fallback. Without it this reader
    // would get the English sentence.
    const body = { code: 1, msg: 'raw', displayMsg: { en: 'English wording', zh: '中文说明', 'zh-hant': '繁體說明' } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })))
    const adapter = new CodeBuddyAdapter({
      session: sessionOf() as never,
      options: () => DEFAULT_CONNECTION,
      language: () => 'zh-CN',
    })
    await expect(drain(adapter, { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '中文说明' })
  })

  it('falls back to the service fields when the reply carries no curated sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 1, msg: 'raw service wording' }),
      { status: 400 },
    )))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'raw service wording' })
  })

  it('keeps the status when the error body cannot be parsed', async () => {
    // Malformed JSON must not mask the status-identified failure.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 500 })))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'SERVER', failure: { status: 500 } })
  })

  it('reads the nested CodeBuddy envelope of a refused chat request', async () => {
    // A refused chat request answers `{error:{data:{code,msg}}}`, so the flat
    // fields are absent and the code has to be read from the nested envelope.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { data: { code: 14018, msg: 'no quota' } } }),
      { status: 402 },
    )))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'QUOTA', failure: { message: 'no quota' } })
  })

  it('prefers a flat envelope code over the nested one', async () => {
    // The first finite code wins, so a service-level code is not shadowed by
    // whatever the nested provider envelope repeats.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 11115, msg: 'outer', error: { data: { code: 14018, msg: 'inner' } } }),
      { status: 400 },
    )))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', failure: { message: 'outer' } })
  })

  it('drops the cached credential on a 401 so the next call re-reads the file', async () => {
    const invalidate = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(drain(adapterOf(sessionOf({ invalidate })), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'AUTH' })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate the credential on a transient server fault', async () => {
    const invalidate = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await expect(drain(adapterOf(sessionOf({ invalidate })), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'SERVER' })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('labels an aborted request as an abort rather than a transport fault', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      throw new TypeError('fetch failed')
    }))
    await expect(drain(adapterOf(sessionOf()), {
      provider: 'codebuddy',
      model: 'm',
      messages: [],
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('labels a bare transport fault with the endpoint it failed against', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'TRANSPORT', message: expect.stringContaining('https://copilot.tencent.com/v2') as unknown as string })
  })

  it('reports a response with no body as an empty response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    await expect(drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })
})
