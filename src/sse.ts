/**
 * Decode an SSE byte stream into event `data` payloads.
 *
 * Framing is `eventsource-parser`'s: chunk reassembly, UTF-8 boundaries, CRLF,
 * BOM, comment lines, and multi-`data:` joining. This module keeps only the
 * protocol decision — the literal `[DONE]` sentinel is yielded so the caller
 * owns final flushing, and EOF before it is truncation rather than a
 * completable response.
 *
 * @module dsh-llm-codebuddy/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload an OpenAI-compatible stream sends after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads.
 * @param stream - raw SSE byte chunks; reads may split anywhere.
 * @param onComment - transport-activity callback; comments never enter the payload stream.
 * @returns each payload in arrival order, `[DONE]` last.
 * @throws LlmError `STREAM_CLOSED` when the stream ends without `[DONE]`.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream(onComment === undefined ? {} : { onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('CodeBuddy SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
