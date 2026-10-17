import { describe, expect, it, vi } from 'vitest'
import { DONE, parseSse } from '../src/sse.js'

/** Build a byte stream that emits `chunks` in order, then closes. */
function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>, onComment?: (comment: string) => void): Promise<string[]> {
  const payloads: string[] = []
  for await (const payload of parseSse(stream, onComment)) payloads.push(payload)
  return payloads
}

describe('parseSse', () => {
  it('yields each payload in arrival order, with [DONE] last', async () => {
    const payloads = await collect(streamOf([
      'data: {"a":1}\n\n',
      'data: {"b":2}\n\n',
      `data: ${DONE}\n\n`,
    ]))
    expect(payloads).toEqual(['{"a":1}', '{"b":2}', DONE])
  })

  it('stops at the sentinel and never reads past it', async () => {
    // Nothing after [DONE] belongs to this response; a provider's trailing
    // bytes must not surface as chunks.
    const payloads = await collect(streamOf([
      `data: ${DONE}\n\n`,
      'data: {"after":true}\n\n',
    ]))
    expect(payloads).toEqual([DONE])
  })

  it('reassembles an event split across arbitrary read boundaries', async () => {
    // A socket read can land mid-line, mid-field, or mid-UTF-8 sequence, so
    // the stream is fed one byte at a time.
    const whole = `data: {"text":"héllo"}\n\ndata: ${DONE}\n\n`
    const bytes = new TextEncoder().encode(whole)
    const payloads: string[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    for await (const payload of parseSse(stream)) payloads.push(payload)
    expect(payloads).toEqual(['{"text":"héllo"}', DONE])
  })

  it('joins multi-line data fields with a newline', async () => {
    const payloads = await collect(streamOf([
      'data: {"a":\ndata: 1}\n\n',
      `data: ${DONE}\n\n`,
    ]))
    expect(payloads[0]).toBe('{"a":\n1}')
  })

  it('accepts CRLF framing', async () => {
    const payloads = await collect(streamOf([
      'data: {"a":1}\r\n\r\n',
      `data: ${DONE}\r\n\r\n`,
    ]))
    expect(payloads).toEqual(['{"a":1}', DONE])
  })

  it('reports comment lines as transport activity without yielding them', async () => {
    const onComment = vi.fn()
    const payloads = await collect(streamOf([
      ': keep-alive\n\n',
      'data: {"a":1}\n\n',
      `data: ${DONE}\n\n`,
    ]), onComment)
    expect(payloads).toEqual(['{"a":1}', DONE])
    expect(onComment).toHaveBeenCalledWith('keep-alive')
  })

  it('does not need a comment callback', async () => {
    await expect(collect(streamOf([`: hb\n\n`, `data: ${DONE}\n\n`]))).resolves.toEqual([DONE])
  })

  it('fails as a truncation when the stream ends without the sentinel', async () => {
    // EOF before [DONE] is a dropped connection, not a completable response.
    await expect(collect(streamOf(['data: {"a":1}\n\n']))).rejects.toMatchObject({
      code: 'STREAM_CLOSED',
      message: expect.stringContaining('[DONE]') as unknown as string,
    })
  })

  it('fails as a truncation when the stream is empty', async () => {
    await expect(collect(streamOf([]))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('surfaces a mid-stream read failure instead of pretending the stream ended', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
      },
      pull(controller) {
        controller.error(new Error('socket reset'))
      },
    })
    await expect(collect(stream)).rejects.toThrow('socket reset')
  })
})
