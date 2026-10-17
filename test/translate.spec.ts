import { describe, expect, it } from 'vitest'
import { mapFinishReason, mapUsage, normalizeToolArguments, translate } from '../src/translate.js'
import { DONE } from '../src/sse.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

async function* from(payloads: readonly string[]): AsyncGenerator<string> {
  for (const payload of payloads) yield payload
}

/** Feed wire payloads through the translator and collect every chunk. */
async function chunksOf(
  payloads: readonly (string | object)[],
  tools: readonly { name: string, parameters: Record<string, unknown> }[] = [],
): Promise<StreamChunk[]> {
  const encoded = payloads.map(payload => typeof payload === 'string' ? payload : JSON.stringify(payload))
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(from(encoded), tools)) chunks.push(chunk)
  return chunks
}

/** One OpenAI-compatible delta payload. */
function delta(deltaValue: unknown, finishReason?: string): object {
  return { choices: [{ delta: deltaValue, ...finishReason === undefined ? {} : { finish_reason: finishReason } }] }
}

function summarize(chunks: readonly StreamChunk[]): string[] {
  return chunks.map((chunk) => {
    switch (chunk.type) {
      case 'block-start': return `${chunk.type}:${chunk.index}:${chunk.blockType}`
      case 'block-end': return `${chunk.type}:${chunk.index}:${chunk.block.type}`
      case 'text-delta': return `${chunk.type}:${chunk.index}:${chunk.text}`
      case 'reasoning-delta': return `${chunk.type}:${chunk.index}:${chunk.text}`
      case 'tool-call-delta': return `${chunk.type}:${chunk.index}:${chunk.id}`
      case 'usage': return `${chunk.type}`
      case 'finish': return `${chunk.type}:${chunk.reason.kind}`
    }
  })
}

describe('translate — text and reasoning', () => {
  it('emits deltas as they arrive and one block per stream', async () => {
    const chunks = await chunksOf([
      delta({ content: 'Hel' }),
      delta({ content: 'lo' }),
      delta({}, 'stop'),
      DONE,
    ])
    expect(summarize(chunks)).toEqual([
      'block-start:0:text',
      'text-delta:0:Hel',
      'text-delta:0:lo',
      'block-end:0:text',
      'finish:stop',
    ])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({
      block: { type: 'text', text: 'Hello' },
    })
  })

  it('accepts both reasoning field spellings and keeps reasoning ahead of text', async () => {
    const chunks = await chunksOf([
      delta({ reasoning_content: 'think-1' }),
      delta({ reasoning: 'think-2' }),
      delta({ content: 'answer' }),
      delta({}, 'stop'),
      DONE,
    ])
    expect(summarize(chunks)).toEqual([
      'block-start:0:reasoning',
      'reasoning-delta:0:think-1',
      'reasoning-delta:0:think-2',
      'block-start:1:text',
      'text-delta:1:answer',
      'block-end:0:reasoning',
      'block-end:1:text',
      'finish:stop',
    ])
  })

  it('ignores an empty delta rather than opening a block', async () => {
    const chunks = await chunksOf([
      delta({ content: '', reasoning_content: '' }),
      delta({}, 'stop'),
      DONE,
    ])
    // No content at all: the stream is a degenerate completion.
    expect(summarize(chunks)).toEqual(['finish:error'])
  })

  it('allocates a new text block after reasoning has been flushed', async () => {
    const chunks = await chunksOf([
      delta({ reasoning_content: 'r' }),
      delta({ content: 'a' }),
      delta({ reasoning_content: 'r2' }),
      delta({}, 'stop'),
      DONE,
    ])
    // Reasoning is one block for the whole stream, so a later reasoning delta
    // appends to it rather than opening a third block.
    expect(summarize(chunks).filter(step => step.startsWith('block-start'))).toEqual([
      'block-start:0:reasoning',
      'block-start:1:text',
    ])
  })
})

describe('translate — tool calls', () => {
  const tool = {
    name: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' }, filters: {} } },
  }

  it('accumulates fragments by wire index into one call', async () => {
    const chunks = await chunksOf([
      delta({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{"query":' } }] }),
      delta({ tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"x"}' } }] }),
      delta({}, 'tool_calls'),
      DONE,
    ], [tool])
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toMatchObject({
      block: { type: 'tool-call', id: 'call-1', name: 'search', arguments: '{"query":"x"}' },
    })
  })

  it('keeps the identity established by the first fragment', async () => {
    // Continuation fragments repeat `id` and `name` as '' or null; a nameless
    // call would be rejected by the harness as UNKNOWN_TOOL.
    const chunks = await chunksOf([
      delta({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{"query":"x"}' } }] }),
      delta({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '' } }] }),
      delta({}, 'tool_calls'),
      DONE,
    ], [tool])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({
      block: { id: 'call-1', name: 'search' },
    })
    const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
    expect(deltas).toHaveLength(2)
    // The blanked continuation must not clear the identity: both deltas carry
    // the established call id, and the name once known is repeated verbatim.
    for (const delta of deltas) {
      expect(delta).toMatchObject({ id: 'call-1', name: 'search', argumentsDelta: expect.any(String) as unknown as string })
    }
    expect(deltas[1]).toMatchObject({ argumentsDelta: '' })
  })

  it('separates interleaved calls by wire index', async () => {
    const chunks = await chunksOf([
      delta({ tool_calls: [
        { index: 0, id: 'c0', function: { name: 'search', arguments: '{"query":' } },
        { index: 1, id: 'c1', function: { name: 'search', arguments: '{"query":' } },
      ] }),
      delta({ tool_calls: [
        { index: 1, function: { arguments: '"b"}' } },
        { index: 0, function: { arguments: '"a"}' } },
      ] }),
      delta({}, 'tool_calls'),
      DONE,
    ], [tool])
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ block: { id: 'c0', arguments: '{"query":"a"}' } })
    expect(ends[1]).toMatchObject({ block: { id: 'c1', arguments: '{"query":"b"}' } })
  })

  it('repairs a double-encoded object in an unconstrained field', async () => {
    const chunks = await chunksOf([
      delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'search', arguments: '{"filters":"{\\"lang\\":\\"ts\\"}"}' } }] }),
      delta({}, 'tool_calls'),
      DONE,
    ], [tool])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({
      block: { arguments: '{"filters":{"lang":"ts"}}' },
    })
  })
})

describe('normalizeToolArguments', () => {
  const tools = [{ name: 'search', parameters: { properties: { q: { type: 'string' }, filters: {} } } }]

  it('decodes an object or array chosen for an unconstrained field', () => {
    expect(normalizeToolArguments('search', '{"filters":"[1,2]"}', tools)).toBe('{"filters":[1,2]}')
    expect(normalizeToolArguments('search', '{"filters":"{\\"a\\":1}"}', tools)).toBe('{"filters":{"a":1}}')
  })

  it('leaves a typed field, a scalar string, and a bare object untouched', () => {
    // `q` declares `type: string`, so its string value must stay a string.
    expect(normalizeToolArguments('search', '{"q":"{\\"a\\":1}"}', tools)).toBe('{"q":"{\\"a\\":1}"}')
    expect(normalizeToolArguments('search', '{"filters":"plain"}', tools)).toBe('{"filters":"plain"}')
    expect(normalizeToolArguments('search', '{"q":"x"}', tools)).toBe('{"q":"x"}')
  })

  it('leaves malformed JSON and an unknown tool untouched', () => {
    expect(normalizeToolArguments('search', '{oops', tools)).toBe('{oops')
    expect(normalizeToolArguments('other', '{"filters":"[1]"}', tools)).toBe('{"filters":"[1]"}')
    expect(normalizeToolArguments('search', '{"filters":"[1]"}', [])).toBe('{"filters":"[1]"}')
  })

  it('leaves a field whose schema constrains its value untouched', () => {
    const constrained = [{ name: 't', parameters: { properties: { f: { anyOf: [{ type: 'object' }] } } } }]
    expect(normalizeToolArguments('t', '{"f":"{\\"a\\":1}"}', constrained)).toBe('{"f":"{\\"a\\":1}"}')
  })

  it('returns the original text when nothing needed decoding', () => {
    // Byte-for-byte preservation is what keeps a provider's own encoding.
    const original = '{"a":1,"b":"x"}'
    expect(normalizeToolArguments('search', original, tools)).toBe(original)
  })
})

describe('mapFinishReason', () => {
  it('maps the three clean OpenAI reasons', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
  })

  it('surfaces an unknown reason as an error carrying its own code', () => {
    // A new provider reason must not be silently reported as a clean stop.
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})

describe('mapUsage', () => {
  it('subtracts cache reads from the input count, since the harness counts them separately', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } }))
      .toEqual({ inputTokens: 70, outputTokens: 5, cacheReadTokens: 30 })
  })

  it('accepts the flat cache field the service also sends', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 }))
      .toEqual({ inputTokens: 60, outputTokens: 5, cacheReadTokens: 40 })
  })

  it('omits cache and reasoning fields the wire did not carry', () => {
    expect(mapUsage({ prompt_tokens: 7, completion_tokens: 3 })).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  it('reports reasoning tokens when disclosed', () => {
    expect(mapUsage({ prompt_tokens: 1, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 } }))
      .toEqual({ inputTokens: 1, outputTokens: 9, reasoningTokens: 4 })
  })

  it('never reports a negative input count', () => {
    // A cache figure larger than the prompt is nonsense, but it must clamp
    // rather than produce a negative token count.
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 20 } }))
      .toMatchObject({ inputTokens: 0, cacheReadTokens: 20 })
  })

  it('defaults absent counts to zero, so the harness never sees undefined', () => {
    expect(mapUsage({} as never)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})

describe('translate — terminal protocol obligations', () => {
  it('emits usage strictly before finish and nothing after finish', async () => {
    const chunks = await chunksOf([
      delta({ content: 'x' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      DONE,
    ])
    const usageAt = chunks.findIndex(chunk => chunk.type === 'usage')
    const finishAt = chunks.findIndex(chunk => chunk.type === 'finish')
    expect(usageAt).toBeGreaterThanOrEqual(0)
    expect(finishAt).toBeGreaterThan(usageAt)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  it('flushes block ends before usage', async () => {
    const chunks = await chunksOf([
      delta({ content: 'x' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      DONE,
    ])
    const endAt = chunks.findIndex(chunk => chunk.type === 'block-end')
    const usageAt = chunks.findIndex(chunk => chunk.type === 'usage')
    expect(endAt).toBeGreaterThanOrEqual(0)
    expect(usageAt).toBeGreaterThan(endAt)
  })

  it('takes the latest usage when the provider sends a trailing usage-only chunk', async () => {
    const chunks = await chunksOf([
      delta({ content: 'x' }, 'stop'),
      { choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 9 } },
      DONE,
    ])
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 9, outputTokens: 9 },
    })
  })

  it('tolerates the explicit null usage on every non-final chunk', async () => {
    // CodeBuddy sends `usage: null`, not an absent field; an `!== undefined`
    // guard would pass null into the mapper and crash.
    const chunks = await chunksOf([
      { choices: [{ delta: { content: 'ok' } }], usage: null },
      delta({}, 'stop'),
      DONE,
    ])
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('defaults to a clean stop when the provider sent no finish reason', async () => {
    const chunks = await chunksOf([delta({ content: 'x' }), DONE])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports an empty completion as an error rather than a clean stop', async () => {
    // A stop with no blocks would hand the loop a turn with nothing in it.
    const chunks = await chunksOf([delta({}, 'stop'), DONE])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } },
    })
  })

  it('keeps a tool-call-only completion a clean tool-calls finish', async () => {
    const chunks = await chunksOf([
      delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }] }, 'tool_calls'),
      DONE,
    ])
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('fails as malformed on an unparseable payload', async () => {
    await expect(chunksOf([delta({ content: 'x' }), '{not json', DONE])).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    })
  })

  it('fails as a truncation when the source ends without [DONE]', async () => {
    await expect(chunksOf([delta({ content: 'x' }, 'stop')])).rejects.toMatchObject({
      code: 'STREAM_CLOSED',
    })
  })

  it('ignores a chunk that carries no choices at all', async () => {
    const chunks = await chunksOf([
      { choices: null },
      { id: 'x', object: 'chat.completion.chunk' },
      delta({ content: 'y' }),
      DONE,
    ])
    expect(chunks.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'y' })
  })
})
