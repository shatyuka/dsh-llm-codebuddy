/**
 * Serialize harness messages into a CodeBuddy (OpenAI-compatible) chat request.
 *
 * Tool results arrive as first-class `role: 'tool'` messages and expand into
 * their own wire entries; images serialize as base64 data-URL content parts.
 * Offloaded image occurrences project to placeholder text, and a request
 * exceeding its image budget fails with `IMAGE_OFFLOAD_REQUIRED` so the
 * harness offloads durably and retries.
 *
 * @module dsh-llm-codebuddy/serialize
 */

import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { WireContentPart, WireMessage, WireRequest, WireTool } from './types.js'

/** The attachment-store face image serialization reads bytes through. */
export interface AttachmentReader {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment>
}

/**
 * Per-request image limits; the service publishes no budget, so these are
 * conservative caps. Exceeding either fails with `IMAGE_OFFLOAD_REQUIRED`.
 */
export interface ImageRequestLimits {
  /** Maximum number of images in one request. */
  maxImages: number
  /** Maximum total encoded image bytes (base64-expanded) in one request. */
  maxBytes: number
}

/** Default image limits: 20 inline images, 20 MiB of base64 payload. */
export const DEFAULT_IMAGE_REQUEST_LIMITS: ImageRequestLimits = { maxImages: 20, maxBytes: 20 * 1024 * 1024 }

/** Total-pixel budget for one request image; the catalog discloses no figure. */
const REQUEST_IMAGE_MAX_PIXELS = 640_000

/** Encoded-byte target for one request image before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** Deterministic request target for one source image; never enlarged. */
function requestImageTarget(ref: ImageAttachmentRef): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_PIXELS), maxBytes: REQUEST_IMAGE_MAX_BYTES }
}

/** Join the text blocks of one message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Refuse image content a text-only model would silently drop. */
function assertSupportedContent(blocks: readonly ContentBlock[], supportsImages: boolean): void {
  if (!supportsImages && contentHasImage(blocks)) {
    throw new LlmError(
      'The selected CodeBuddy model does not accept image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Serialize one assistant turn: text, replayed reasoning, and tool calls. */
function serializeAssistant(message: RequestMessage & { role: 'assistant' }): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id as unknown as string,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    // Never null: gateways rejecting null content would break every later turn.
    content: text,
    // Reasoning replays only on tool-call turns, where thinking-mode passback
    // requires it; elsewhere it is ignored and would only cost tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/** Collect image references from a block list. */
function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
  }
}

/**
 * Resolve every retained image reference to its request version. Offloaded
 * occurrences projected to text before this step, so they read nothing.
 */
async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentReader,
  signal?: AbortSignal,
): Promise<Map<string, RequestImageAttachment>> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  if (refs.size === 0) return new Map()
  const ordered = [...refs.values()]
  const projected = await Promise.all(ordered.map(ref => attachments.readImageRequest(ref, requestImageTarget(ref), signal)))
  const versions = new Map<string, RequestImageAttachment>()
  ordered.forEach((ref, index) => {
    const version = projected[index]
    if (version === undefined) {
      throw new LlmError(`CodeBuddy request image ${ref.attachmentId} could not be read.`, 'INVALID_REQUEST')
    }
    versions.set(ref.attachmentId, version)
  })
  return versions
}

/**
 * Fail with `IMAGE_OFFLOAD_REQUIRED` when the retained occurrences exceed the
 * budget, naming how many more the harness must offload.
 */
function assertImagesFit(
  messages: readonly RequestMessage[],
  images: ReadonlyMap<string, RequestImageAttachment>,
  limits: ImageRequestLimits,
): void {
  const excess = requiredImageOffload(
    messages,
    {
      // The wire carries base64 data URLs, so the budget counts expanded length.
      representation: 'base64',
      maxBytes: limits.maxBytes,
      maxImages: limits.maxImages,
    },
    block => {
      const version = images.get(block.attachment.attachmentId)
      if (version === undefined) {
        throw new LlmError(`CodeBuddy request image ${block.attachment.attachmentId} was not prepared.`, 'INVALID_REQUEST')
      }
      return version.bytes
    },
  )
  if (excess > 0) {
    throw new LlmError(
      `CodeBuddy request images exceed the route budget; ${excess} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages: excess },
    )
  }
}

/** One image as wire parts: a text handle describing it, then the data URL. */
function imageParts(
  attachmentId: string,
  images: ReadonlyMap<string, RequestImageAttachment>,
  precededByContent: boolean,
): WireContentPart[] {
  const version = images.get(attachmentId)
  if (version === undefined) {
    throw new LlmError(`CodeBuddy request image ${attachmentId} was not prepared.`, 'INVALID_REQUEST')
  }
  return [
    {
      type: 'text',
      text: `${precededByContent ? '\n' : ''}${requestImageHandleText(version.attachment, version)}`,
    },
    {
      type: 'image_url',
      image_url: {
        url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
      },
    },
  ]
}

/** Ordered wire parts for one block list, resolving images through the map. */
function contentParts(
  blocks: readonly ContentBlock[],
  images: ReadonlyMap<string, RequestImageAttachment>,
): WireContentPart[] {
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(...imageParts(block.attachment.attachmentId, images, parts.length > 0))
    }
  }
  return parts
}

/** Compact string form when every part is text, otherwise the parts array. */
function userContent(parts: readonly WireContentPart[]): string | WireContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/**
 * Serialize the projected conversation in order.
 *
 * Tool results remain `role: 'tool'` messages, including their image parts.
 * Earlier user images forward into the last user message for compatibility
 * with services that only honor image content there.
 * @param messages - the projected conversation (no offloaded occurrences).
 * @param supportsImages - whether the selected model declared image input.
 * @param images - request versions for every image reference, keyed by id.
 * @returns the wire messages.
 */
export function serializeMessages(
  messages: readonly RequestMessage[],
  supportsImages: boolean,
  images: ReadonlyMap<string, RequestImageAttachment> = new Map(),
): WireMessage[] {
  // Find the last user message first so its own images stay in place.
  let lastUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === undefined) continue
    if (message.role === 'user') lastUserIndex = i
  }
  const wire: WireMessage[] = []
  const forwarded: WireContentPart[] = []
  for (const [messageIndex, message] of messages.entries()) {
    assertSupportedContent(message.content, supportsImages)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    if (message.role === 'tool') {
      const resultParts = contentParts(message.content, images)
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId as unknown as string,
        // Empty output still needs some content on the wire.
        content: resultParts.some(part => part.type === 'image_url')
          ? resultParts
          : flattenText(message.content) || '(no output)',
      })
      continue
    }
    if (message.role !== 'user') {
      // Nothing may silently drop model-visible content; a role this wire
      // route cannot express fails the request instead.
      throw new LlmError(
        `CodeBuddy wire route does not support ${message.role} messages.`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const userParts = contentParts(message.content, images)
    const userText = flattenText(message.content)
    const isLastUser = messageIndex === lastUserIndex
    if (userParts.length > 0) {
      // Image parts leave every user turn but the final one.
      const keptParts = isLastUser ? userParts : userParts.filter(part => part.type !== 'image_url')
      forwarded.push(...(isLastUser ? [] : userParts.filter(part => part.type === 'image_url')))
      if (keptParts.length > 0) {
        wire.push({ role: 'user', content: userContent(keptParts) })
      } else {
        // The message carried only images; keep a placeholder user turn so
        // later tool results still follow one on the wire.
        wire.push({ role: 'user', content: userText })
      }
    } else if (userText.length > 0) {
      wire.push({ role: 'user', content: userText })
    }
  }
  if (forwarded.length > 0) {
    const lastUser = [...wire].reverse().find(message => message.role === 'user')
    if (lastUser !== undefined) {
      const existing = lastUser.content
      lastUser.content = Array.isArray(existing)
        ? [...forwarded, ...existing]
        : [...forwarded, { type: 'text', text: existing }]
    } else {
      wire.push({ role: 'user', content: forwarded })
    }
  }
  return wire
}

/**
 * Build the chat-completions request body. Always streaming with usage
 * reporting; absent options are omitted rather than sent as null so the
 * provider's own defaults apply.
 * @param options - the assembled harness request.
 * @param supportsImages - whether the selected model declared image input.
 * @param attachments - the durable attachment store, when images may occur.
 * @param reasoningSummary - the model's catalog thinking-summary level.
 * @param temperature - the model's catalog sampling temperature, used only
 *   when the caller expressed no preference.
 * @param limits - per-request image limits; defaults when omitted.
 * @returns the request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  supportsImages: boolean,
  attachments?: AttachmentReader,
  reasoningSummary?: string,
  temperature?: number,
  limits: ImageRequestLimits = DEFAULT_IMAGE_REQUEST_LIMITS,
): Promise<WireRequest> {
  // The offloaded set is a durable surface fact shared by every route; only
  // the placeholder text is route-owned.
  const projected = projectOffloadedImages(options.messages, ref => offloadedImageText(ref))
  const hasImages = supportsImages && projected.some(message => contentHasImage(message.content))
  const images = hasImages && attachments !== undefined
    ? await prepareRequestImages(projected, attachments, options.signal)
    : new Map<string, RequestImageAttachment>()
  if (hasImages) assertImagesFit(projected, images, limits)
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(projected, supportsImages, images))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    // An explicit caller value wins; the catalog figure only fills the gap.
    ...options.temperature !== undefined
      ? { temperature: options.temperature }
      : temperature === undefined ? {} : { temperature },
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort },
    // A summary only qualifies the effort it accompanies.
    ...options.reasoningEffort === undefined || reasoningSummary === undefined
      ? {}
      : { reasoning_summary: reasoningSummary },
  }
}
