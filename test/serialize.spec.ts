import { describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_IMAGE_REQUEST_LIMITS,
  serializeMessages,
  serializeRequest,
} from '../src/serialize.js'
import type { AttachmentReader } from '../src/serialize.js'
import { ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** A durable image reference of the given id. */
function imageRef(id: string, over: { width?: number, height?: number, bytes?: number } = {}): {
  attachmentId: string
  mediaType: 'image/png'
  bytes: number
  width: number
  height: number
} {
  return {
    attachmentId: id,
    mediaType: 'image/png',
    bytes: over.bytes ?? 4,
    width: over.width ?? 2,
    height: over.height ?? 2,
  }
}

/** A prepared request version of one image, with the given payload bytes. */
function requestImage(id: string, data: readonly number[] = [1, 2, 3]): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`variant-${id}`),
    attachment: imageRef(id) as never,
    data: Uint8Array.from(data),
    mediaType: 'image/png',
    bytes: data.length,
    width: 2,
    height: 2,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

function userMessage(blocks: readonly ContentBlock[]) {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

/** An injected context message: the same role, a foreign source. */
function contextMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'runtime-context' } as never })
}

function optionsOf(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'codebuddy',
    model: 'glm-5',
    messages: [userMessage([{ type: 'text', text: 'hi' }])],
    ...over,
  }
}

/** An attachment reader that serves the given prepared images by id. */
function readerOf(images: Readonly<Record<string, RequestImageAttachment>>): AttachmentReader & { readImageRequest: ReturnType<typeof vi.fn> } {
  return {
    readImageRequest: vi.fn(async (ref: { attachmentId: string }) => {
      const found = images[ref.attachmentId]
      if (found === undefined) throw new Error(`unexpected image ${ref.attachmentId}`)
      return found
    }),
  } as never
}

describe('serializeMessages — basic roles', () => {
  it('maps a system prompt, user text, and an assistant turn', () => {
    const wire = serializeMessages([
      createSystemMessage('be helpful'),
      userMessage([{ type: 'text', text: 'hello' }]),
      createAssistantMessage({
        content: [{ type: 'text', text: 'hi there' }],
        source: { provider: 'codebuddy', model: 'm' },
      }),
    ], false)

    expect(wire).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  it('joins the text blocks of one message without a separator', () => {
    const wire = serializeMessages([userMessage([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])], false)
    expect(wire[0]).toEqual({ role: 'user', content: 'ab' })
  })

  it('omits a user turn whose text blocks are all empty', () => {
    // An empty wire message would still consume a turn and can trip gateways
    // that reject blank content; nothing user-visible was said, so nothing is
    // sent.
    expect(serializeMessages([
      userMessage([{ type: 'text', text: '' }]),
    ], false)).toEqual([])
  })

  it('drops an empty block but keeps the rest of the turn', () => {
    expect(serializeMessages([
      userMessage([{ type: 'text', text: '' }, { type: 'text', text: 'x' }]),
    ], false)).toEqual([{ role: 'user', content: 'x' }])
  })

  it('sends an assistant turn with no text as an empty string, never null', () => {
    // Gateways rejecting null content would break every later turn.
    const wire = serializeMessages([createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('call'), name: 't', arguments: '{}' }],
      source: { provider: 'codebuddy', model: 'm' },
    })], false)
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '' })
  })

  it('replays reasoning only on a tool-call turn', () => {
    const withCall = serializeMessages([createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: ToolCallId('c'), name: 't', arguments: '{}' },
      ],
      source: { provider: 'codebuddy', model: 'm' },
    })], false)
    expect(withCall[0]).toMatchObject({ reasoning_content: 'thinking' })

    // Elsewhere reasoning is ignored and would only cost tokens.
    const plain = serializeMessages([createAssistantMessage({
      content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }],
      source: { provider: 'codebuddy', model: 'm' },
    })], false)
    expect(plain[0]).not.toHaveProperty('reasoning_content')
  })

  it('serializes tool calls in the OpenAI function shape', () => {
    const wire = serializeMessages([createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('call-7'), name: 'search', arguments: '{"q":"x"}' }],
      source: { provider: 'codebuddy', model: 'm' },
    })], false)
    expect(wire[0]).toMatchObject({
      tool_calls: [{ id: 'call-7', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    })
  })

  it('sends tool results as their own role messages, correlated by id', () => {
    const wire = serializeMessages([createToolResultMessage({
      callId: ToolCallId('call-7'),
      content: [{ type: 'text', text: 'the result' }],
      isError: false,
    })], false)
    expect(wire[0]).toEqual({ role: 'tool', tool_call_id: 'call-7', content: 'the result' })
  })

  it('gives an empty tool result a placeholder so the wire never carries blank content', () => {
    const wire = serializeMessages([createToolResultMessage({
      callId: ToolCallId('call-7'),
      content: [],
      isError: false,
    })], false)
    expect(wire[0]).toMatchObject({ content: '(no output)' })
  })

  it('joins a multi-block tool result as text', () => {
    const wire = serializeMessages([createToolResultMessage({
      callId: ToolCallId('c'),
      content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: '\nline 2' }],
      isError: true,
    })], false)
    expect(wire[0]).toMatchObject({ content: 'line 1\nline 2' })
  })
})

describe('serializeMessages — images', () => {
  it('refuses image content a text-only model would silently drop', () => {
    expect(() => serializeMessages([userMessage([{ type: 'image', attachment: imageRef('i') as never }])], false))
      .toThrow(/does not accept image content/u)
  })

  it('serializes an image as a handle text plus a base64 data URL', () => {
    const wire = serializeMessages(
      [userMessage([{ type: 'image', attachment: imageRef('img1') as never }])],
      true,
      new Map([['img1', requestImage('img1', [1, 2, 3])]]),
    )
    const content = wire[0]?.content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as { type: string, text?: string, image_url?: { url: string } }[]
    expect(parts.map(part => part.type)).toEqual(['text', 'image_url'])
    expect(parts[0]?.text).toContain('img1')
    expect(parts[1]?.image_url?.url).toBe('data:image/png;base64,AQID')
  })

  it('keeps each image in the message that carried it', () => {
    // The service reads a turn's final user message as the human input and
    // routes on its images, so an image must not migrate onto another message.
    const wire = serializeMessages([
      userMessage([{ type: 'image', attachment: imageRef('early') as never }]),
      contextMessage('context'),
      createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'x', model: 'm' } }),
      userMessage([{ type: 'text', text: 'later' }]),
    ], true, new Map([['early', requestImage('early', [1])]]))

    // Each turn is ordered context first, human input last.
    expect(wire.map(message => message.role)).toEqual(['user', 'user', 'assistant', 'user'])
    expect(wire[0]?.content).toBe('context')
    // The image stays on the message that carried it.
    const parts = wire[1]?.content as { type: string, image_url?: { url: string } }[]
    expect(parts.filter(part => part.type === 'image_url').map(part => part.image_url?.url))
      .toEqual(['data:image/png;base64,AQ=='])
    expect(wire[3]?.content).toBe('later')
  })

  it('puts the human input after injected context of the same turn', () => {
    const wire = serializeMessages([
      userMessage([{ type: 'text', text: 'real ask' }]),
      contextMessage('context'),
    ], false)

    expect(wire.map(message => message.content)).toEqual(['context', 'real ask'])
  })

  it('leaves a turn with no human input in its existing order', () => {
    const wire = serializeMessages([
      userMessage([{ type: 'image', attachment: imageRef('only') as never }]),
      createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'r' }], isError: false }),
    ], true, new Map([['only', requestImage('only')]]))

    // Every message is injected, so there is nothing to move: the image stays
    // in place and the tool result still follows it.
    expect(Array.isArray(wire[0]?.content)).toBe(true)
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'r' })
  })

  it('still moves the human input when the request ends with a tool result', () => {
    // The common path: a step that called a tool leaves assistant and tool
    // messages after the turn's user messages, so the open turn is not the
    // array tail.
    const wire = serializeMessages([
      userMessage([{ type: 'text', text: 'real ask' }]),
      contextMessage('context'),
      createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'x', model: 'm' } }),
      createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'out' }], isError: false }),
    ], false)

    expect(wire.map(message => message.content)).toEqual(['context', 'real ask', 'ok', 'out'])
    expect(wire.map(message => message.role)).toEqual(['user', 'user', 'assistant', 'tool'])
  })

  it('lays out closed turns the same way as the open one', () => {
    // A turn must look identical whether it is the open turn or history, so the
    // result depends only on the messages and each turn's prefix stays stable.
    const wire = serializeMessages([
      userMessage([{ type: 'text', text: 'first ask' }]),
      contextMessage('first context'),
      createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'x', model: 'm' } }),
      userMessage([{ type: 'text', text: 'second ask' }]),
      contextMessage('second context'),
    ], false)

    expect(wire.map(message => message.content)).toEqual([
      'first context',
      'first ask',
      'done',
      'second context',
      'second ask',
    ])
  })

  it('keeps a tool result image in place rather than forwarding it', () => {
    const wire = serializeMessages([createToolResultMessage({
      callId: ToolCallId('c'),
      content: [{ type: 'image', attachment: imageRef('tool-img') as never }],
      isError: false,
    })], true, new Map([['tool-img', requestImage('tool-img', [7])]]))

    const content = wire[0]?.content as { type: string }[]
    expect(content.map(part => part.type)).toEqual(['text', 'image_url'])
  })

  it('fails rather than emitting an unresolved image reference', () => {
    expect(() => serializeMessages(
      [userMessage([{ type: 'image', attachment: imageRef('missing') as never }])],
      true,
      new Map(),
    )).toThrow(/was not prepared/u)
  })
})

describe('serializeMessages — unsupported roles', () => {
  it('fails instead of silently dropping model-visible content', () => {
    const developer = {
      role: 'developer',
      id: 'dev-1',
      content: [{ type: 'text', text: 'x' }],
      source: { kind: 'user' },
    }
    expect(() => serializeMessages([developer] as never, false))
      .toThrow(/does not support developer messages/u)
  })
})

describe('serializeRequest', () => {
  it('always streams with usage reporting', async () => {
    const body = await serializeRequest(optionsOf(), false)
    expect(body).toMatchObject({ model: 'glm-5', stream: true, stream_options: { include_usage: true } })
  })

  it('omits absent options rather than sending them as null', async () => {
    const body = await serializeRequest(optionsOf(), false)
    for (const key of ['temperature', 'max_tokens', 'stop', 'reasoning_effort', 'tools', 'reasoning_summary']) {
      expect(body, key).not.toHaveProperty(key)
    }
  })

  it('maps the assembled options onto the wire fields', async () => {
    const body = await serializeRequest(optionsOf({
      temperature: 0.2,
      maxTokens: 1234,
      stop: ['###'],
      reasoningEffort: 'high' as never,
    }), false, undefined, 'auto')
    expect(body).toMatchObject({
      temperature: 0.2,
      max_tokens: 1234,
      stop: ['###'],
      reasoning_effort: 'high',
      reasoning_summary: 'auto',
    })
  })

  it('lets an explicit caller temperature win over the catalog figure', async () => {
    const explicit = await serializeRequest(optionsOf({ temperature: 0.1 }), false, undefined, undefined, 0.9)
    expect(explicit.temperature).toBe(0.1)

    // With no preference expressed, the catalog's figure fills the gap.
    const filled = await serializeRequest(optionsOf(), false, undefined, undefined, 0.9)
    expect(filled.temperature).toBe(0.9)
  })

  it('sends a summary only alongside the effort it qualifies', async () => {
    const noEffort = await serializeRequest(optionsOf(), false, undefined, 'auto')
    expect(noEffort).not.toHaveProperty('reasoning_summary')

    const noSummary = await serializeRequest(optionsOf({ reasoningEffort: 'max' as never }), false)
    expect(noSummary).not.toHaveProperty('reasoning_summary')
  })

  it('prepends the one-shot system prompt ahead of the messages', async () => {
    const body = await serializeRequest(optionsOf({ system: 'be terse' }), false)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('declares tools in the OpenAI function shape, and omits an empty list', async () => {
    const body = await serializeRequest(optionsOf({
      tools: [{ name: 'search', description: 'find', parameters: { type: 'object' } }],
    }), false)
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'search', description: 'find', parameters: { type: 'object' } } },
    ])

    const empty = await serializeRequest(optionsOf({ tools: [] }), false)
    expect(empty).not.toHaveProperty('tools')
  })

  it('reads request images through the attachment store at the capped target', async () => {
    const reader = readerOf({ img1: requestImage('img1', [1]) })
    const body = await serializeRequest(optionsOf({
      messages: [userMessage([{ type: 'image', attachment: imageRef('img1', { width: 4000, height: 3000 }) as never }])],
    }), true, reader)

    expect(reader.readImageRequest).toHaveBeenCalledTimes(1)
    const [, target] = reader.readImageRequest.mock.calls[0] as [unknown, { width: number, height: number, maxBytes: number }]
    expect(target.width * target.height).toBeLessThanOrEqual(640_000)
    expect(target.width).toBeLessThan(4000)
    expect(target.maxBytes).toBe(1024 * 1024)
    expect(body.messages[0]?.content).toBeTruthy()
  })

  it('never enlarges a source image below the pixel budget', async () => {
    const reader = readerOf({ small: requestImage('small', [1]) })
    await serializeRequest(optionsOf({
      messages: [userMessage([{ type: 'image', attachment: imageRef('small', { width: 100, height: 50 }) as never }])],
    }), true, reader)
    const [, target] = reader.readImageRequest.mock.calls[0] as [unknown, { width: number, height: number }]
    expect(target).toMatchObject({ width: 100, height: 50 })
  })

  it('fails with IMAGE_OFFLOAD_REQUIRED when the request exceeds its image count', async () => {
    const images = Array.from({ length: DEFAULT_IMAGE_REQUEST_LIMITS.maxImages + 1 }, (_, index) => `img-${index}`)
    const reader = readerOf(Object.fromEntries(images.map(id => [id, requestImage(id, [1])])))
    const messages = [userMessage(images.map(id => ({ type: 'image', attachment: imageRef(id) as never })))]

    await expect(serializeRequest(optionsOf({ messages }), true, reader)).rejects.toMatchObject({
      code: 'IMAGE_OFFLOAD_REQUIRED',
      failure: { offloadImages: 1 },
    })
  })

  it('fails with IMAGE_OFFLOAD_REQUIRED when the request exceeds its byte budget', async () => {
    // Two images at 3 bytes each against a 5-byte budget: one occurrence over.
    const big = (id: string) => ({
      ...requestImage(id, [1, 2, 3]),
      bytes: 3,
    })
    const reader = readerOf({ a: big('a'), b: big('b') })
    const messages = [userMessage([
      { type: 'image', attachment: imageRef('a') as never },
      { type: 'image', attachment: imageRef('b') as never },
    ])]
    await expect(serializeRequest(
      optionsOf({ messages }),
      true,
      reader,
      undefined,
      undefined,
      { maxImages: 10, maxBytes: 5 },
    )).rejects.toMatchObject({
      code: 'IMAGE_OFFLOAD_REQUIRED',
      failure: { offloadImages: 1 },
    })
  })

  it('projects an offloaded occurrence to placeholder text without reading bytes', async () => {
    const reader = readerOf({})
    const body = await serializeRequest(optionsOf({
      messages: [userMessage([{ type: 'image', attachment: imageRef('gone') as never, offloaded: true }])],
    }), true, reader)

    expect(reader.readImageRequest).not.toHaveBeenCalled()
    expect(JSON.stringify(body.messages)).toContain('image omitted')
  })

  it('does not read images at all when the model is text-only', async () => {
    // A text-only model with image content is refused by the serializer, and
    // nothing should be read from the attachment store on the way there.
    const reader = readerOf({})
    await expect(serializeRequest(optionsOf({
      messages: [userMessage([{ type: 'image', attachment: imageRef('i') as never }])],
    }), false, reader)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(reader.readImageRequest).not.toHaveBeenCalled()
  })

  it('fails rather than silently dropping pixels when no attachment store was resolved', async () => {
    // Nothing can be read, so the image budget cannot be accounted for; the
    // serializer fails instead of sending a text-only request that quietly
    // loses the image. The adapter raises its own clearer error before this
    // point when a host has no attachment service.
    await expect(serializeRequest(optionsOf({
      messages: [userMessage([{ type: 'image', attachment: imageRef('i') as never }])],
    }), true, undefined)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
