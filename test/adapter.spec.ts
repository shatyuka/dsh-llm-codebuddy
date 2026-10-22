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

function adapterOf(
  session: ReturnType<typeof sessionOf>,
  connection: CodeBuddyConnectionOptions = DEFAULT_CONNECTION,
  turnOf?: (sessionId: string) => number | undefined,
) {
  return new CodeBuddyAdapter({
    session: session as never,
    options: () => connection,
    language: () => undefined,
    ...turnOf === undefined ? {} : { turnOf: () => turnOf },
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

  it('sends one X-Conversation-Request-ID per turn and nothing else', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const user = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const adapter = adapterOf(sessionOf(), DEFAULT_CONNECTION, () => 2)

    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-1' })

    const first = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    // CodeBuddy's 32-hex shape, hashed rather than echoing the turn number.
    expect(first['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
    // The trace family is deliberately not sent; the request id travels alone.
    for (const name of ['x-trace-id', 'b3', 'x-b3-traceid', 'x-b3-spanid', 'x-b3-parentspanid', 'x-b3-sampled']) {
      expect(first[name]).toBeUndefined()
    }
  })

  it('gives each turn its own request id while keeping one turn stable', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const user = createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } })
    let turn = 1
    const adapter = adapterOf(sessionOf(), DEFAULT_CONNECTION, () => turn)

    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 's' })
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 's' })
    turn = 2
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 's' })

    const [one, again, two] = fetchMock.mock.calls.map(call =>
      ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Conversation-Request-ID'])
    expect(again).toBe(one)
    expect(two).not.toBe(one)
  })

  it('names the turn from the host counter, ignoring mid-turn human messages', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const user = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    // A steer: a second human message inside the same turn. The counter does not move.
    const steer = createUserMessage({ content: [{ type: 'text', text: 'also' }], source: { kind: 'user' } })
    const adapter = adapterOf(sessionOf(), DEFAULT_CONNECTION, () => 7)

    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-1' })
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user, steer], sessionId: 'sess-1' })

    const [first, second] = fetchMock.mock.calls.map(call =>
      ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Conversation-Request-ID'])
    // One turn, one id — the steer must not split it.
    expect(second).toBe(first)
  })

  it('scopes the turn counter to its session', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const user = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    const adapter = adapterOf(sessionOf(), DEFAULT_CONNECTION, () => 1)

    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-a' })
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-b' })

    const [a, b] = fetchMock.mock.calls.map(call =>
      ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Conversation-Request-ID'])
    // Turn 1 of two different sessions must not collide.
    expect(a).not.toBe(b)
  })

  it('picks up a turn reader that the host registers after construction', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const user = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    // The registries are not mounted when the plugin loads, only afterwards.
    let reader: ((sessionId: string) => number | undefined) | undefined
    const adapter = new CodeBuddyAdapter({
      session: sessionOf() as never,
      options: () => DEFAULT_CONNECTION,
      language: () => undefined,
      turnOf: () => reader,
    })

    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-1' })
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Conversation-Request-ID']).toBeUndefined()

    reader = () => 3
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-1' })
    expect(((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('omits the request id when the host cannot name the turn', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const user = createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
    // A cold session: the lookup cannot resolve a turn.
    const adapter = adapterOf(sessionOf(), DEFAULT_CONNECTION, () => undefined)

    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [user], sessionId: 'sess-1' })

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['X-Conversation-Request-ID']).toBeUndefined()
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

describe('stream — prompt wording', () => {
  /** The identity the service refuses, as the harness assembles it. */
  const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
  const systemOf = (call: unknown): string => {
    const init = (call as [string, RequestInit])[1]
    const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
    return body.messages.find(message => message.role === 'system')?.content ?? ''
  }

  it('adjusts the opening sentence before the request leaves', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    await drain(adapterOf(sessionOf()), {
      provider: 'codebuddy', model: 'm', messages: [], system: `${IDENTITY}\n\nBody.`,
    })
    expect(systemOf(fetchMock.mock.calls[0])).toBe('You are an AI agent powered by: DeepSeek Harness.\n\nBody.')
  })

  it('leaves the phrase alone when it is not the opening', async () => {
    // Only an opening is worded this way, so an inner occurrence must survive.
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const system = `Intro.\n\n${IDENTITY}\n\nBody.`
    await drain(adapterOf(sessionOf()), { provider: 'codebuddy', model: 'm', messages: [], system })
    expect(systemOf(fetchMock.mock.calls[0])).toBe(system)
  })

  it('adjusts a configured base too, since it still reaches this deployment', async () => {
    // The route decides, not the host: a proxy in front of the same deployment
    // needs the same wording.
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = adapterOf(sessionOf(), { ...DEFAULT_CONNECTION, baseURL: 'https://proxy.example/v2' })
    await drain(adapter, { provider: 'codebuddy', model: 'm', messages: [], system: IDENTITY })
    expect(systemOf(fetchMock.mock.calls[0])).toBe('You are an AI agent powered by: DeepSeek Harness.')
  })

  it('never edits what the user typed', async () => {
    // Routing input through this rewrite would make the wire disagree with the
    // user's own words.
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    await drain(adapterOf(sessionOf()), {
      provider: 'codebuddy', model: 'm', messages: [createUserMessage({ content: [{ type: 'text', text: IDENTITY }], source: { kind: 'user' } })],
    })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
    expect(body.messages.find(message => message.role === 'user')?.content).toBe(IDENTITY)
  })

  it('never edits what a tool returned', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const toolResult = 'without naming another target, they mean this GUI.'
    await drain(adapterOf(sessionOf()), {
      provider: 'codebuddy',
      model: 'm',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }),
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: toolResult }],
        } as never,
      ],
    })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
    expect(body.messages.find(message => message.role === 'tool')?.content).toBe(toolResult)
  })

  it('adjusts the labels of a runtime-context snapshot', async () => {
    const fetchMock = vi.fn(async () => sseResponse([{ choices: [{ delta: { content: 'x' } }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const snapshot = 'Current runtime context. This snapshot supersedes earlier ones.\n\n'
      + 'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:1".'
    // `runtime-context` is declared by the loop package, which this plugin does
    // not depend on: asserted here, not imported.
    const message = createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: { kind: 'runtime-context' } as never,
    })
    await drain(adapterOf(sessionOf()), {
      provider: 'codebuddy', model: 'm', messages: [message],
    })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(String(init.body)) as { messages: { role: string, content: string }[] }
    const sent = body.messages.find(message => message.role === 'user')?.content ?? ''
    expect(sent).toContain('The DeepSeek Harness Web GUI URL in effect:')
    expect(sent).toContain('Current runtime context. This snapshot supersedes earlier ones.')
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

  /** An adapter failing with one envelope, in one language. */
  function failingWith(body: object, language: () => string | undefined, status = 400): CodeBuddyAdapter {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
    return new CodeBuddyAdapter({
      session: sessionOf() as never,
      options: () => DEFAULT_CONNECTION,
      language,
    })
  }

  it('reports the service wording in the language the client is displaying', async () => {
    const body = { code: 1, msg: 'raw', displayMsg: { en: 'English wording', zh: '中文说明', 'zh-hant': '繁體說明' } }
    await expect(drain(failingWith(body, () => 'zh'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '中文说明' })
    await expect(drain(failingWith(body, () => 'zh-TW'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '繁體說明' })
    await expect(drain(failingWith(body, () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
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

  /** A reply carrying both curated halves, in every language the service ships. */
  const CURATED = {
    displayMsg: { en: 'msg-en', zh: '测试信息', 'zh-hant': '測試訊息' },
    displayTips: { en: 'tips-en', zh: '测试提示', 'zh-hant': '測試提示' },
  }

  it('reports the advice after the statement', async () => {
    await expect(drain(failingWith(CURATED, () => 'zh-CN'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '测试信息：测试提示' })
  })

  it('reports the Traditional wording for a Traditional client', async () => {
    await expect(drain(failingWith(CURATED, () => 'zh-TW'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '測試訊息：測試提示' })
  })

  it('reports the English wording for an English client', async () => {
    await expect(drain(failingWith(CURATED, () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'msg-en: tips-en' })
  })

  /** One reply whose statement ends with `ending`. */
  const endingWith = (statement: string) => ({ code: 1, displayMsg: { en: statement }, displayTips: { en: 'tips' } })

  it('adds a full-width colon after an unpunctuated Chinese statement', async () => {
    await expect(drain(failingWith({ code: 1, displayMsg: { zh: '测试' }, displayTips: { zh: '提示' } }, () => 'zh'),
      { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '测试：提示' })
  })

  it('adds nothing after a Chinese statement that ends a sentence', async () => {
    for (const statement of ['测试。', '测试！', '测试？', '测试…']) {
      await expect(drain(failingWith({ code: 1, displayMsg: { zh: statement }, displayTips: { zh: '提示' } }, () => 'zh'),
        { provider: 'codebuddy', model: 'm', messages: [] }))
        .rejects.toMatchObject({ message: `${statement}提示` })
    }
  })

  it('adds nothing after a Chinese statement that ends a clause', async () => {
    const body = { code: 1, displayMsg: { zh: '测试：' }, displayTips: { zh: '提示' } }
    await expect(drain(failingWith(body, () => 'zh'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: '测试：提示' })
  })

  it('adds a colon and a space after an unpunctuated Latin statement', async () => {
    await expect(drain(failingWith(endingWith('msg'), () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'msg: tips' })
  })

  it('adds one space after a Latin statement that ends a sentence', async () => {
    for (const statement of ['msg.', 'msg!', 'msg?', 'msg…']) {
      await expect(drain(failingWith(endingWith(statement), () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
        .rejects.toMatchObject({ message: `${statement} tips` })
    }
  })

  it('adds one space after a Latin statement that ends a clause', async () => {
    await expect(drain(failingWith(endingWith('msg:'), () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'msg: tips' })
  })

  it('follows the statement text, not the client language, for the separator', async () => {
    // An English statement on a Chinese client still reads as Latin: the
    // separator has to match the text being displayed.
    await expect(drain(failingWith(endingWith('msg'), () => 'zh-CN'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'msg: tips' })
  })

  it('reports the advice alone when the reply carries no statement', async () => {
    const body = { code: 1, displayTips: { zh: '测试提示' } }
    await expect(drain(failingWith(body, () => 'zh'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: '测试提示' })
  })

  it('does not repeat advice that matches the statement', async () => {
    const body = { code: 1, displayMsg: { en: 'same' }, displayTips: { en: 'same' } }
    await expect(drain(failingWith(body, () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ message: 'same' })
  })

  it('does not let the advice steer the failure code', async () => {
    // Only the statement classifies, even when the advice holds the wording a
    // classifier would match.
    const body = {
      code: 1,
      displayMsg: { en: 'msg' },
      displayTips: { en: 'quota exceeded' },
    }
    await expect(drain(failingWith(body, () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('shows advice-only wording under the status-derived code', async () => {
    // The cost of keeping advice out of classification, asserted so the
    // tradeoff stays visible.
    const body = { code: 1, displayTips: { en: 'insufficient balance' } }
    await expect(drain(failingWith(body, () => 'en-US'), { provider: 'codebuddy', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'insufficient balance' })
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
