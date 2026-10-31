/**
 * Provider-specific wording for this route's prompt.
 *
 * Product names stay, since the agent needs them to find and extend the checkout.
 *
 * @module dsh-llm-codebuddy/prompt
 */

/** Anchored without `m`: a message opens once, so an inner match is the model's own text. */
const IDENTITY = /^You are an AI agent powered by(?!:) DeepSeek Harness/
const IDENTITY_REPLACEMENT = 'You are an AI agent powered by: DeepSeek Harness'

const WEB_SURFACE_TAIL = 'without naming another target, they mean this GUI.'
const WEB_SURFACE_REPLACEMENT = 'without naming another target, they mean this Web GUI.'

/** Path sentence, and its rewording. */
const PATH_SIGNATURE = 'Relative paths resolve from the workspace root'
const PATH_SIGNATURE_REPLACEMENT = 'Relative paths resolve against the workspace root'

/** Runtime-context labels, and the rewording that says the same thing. */
const RUNTIME_LABELS: readonly (readonly [string, string])[] = [
  [
    'Current DeepSeek Harness implementation checkout:',
    'The DeepSeek Harness implementation checkout in effect:',
  ],
  [
    'Current DeepSeek Harness Web GUI URL:',
    'The DeepSeek Harness Web GUI URL in effect:',
  ],
]

/**
 * Adjust the prompt wording. Idempotent.
 * @param text - a system or assistant message body.
 */
export function adjustPromptText(text: string): string {
  return text
    .replace(IDENTITY, IDENTITY_REPLACEMENT)
    .replace(WEB_SURFACE_TAIL, WEB_SURFACE_REPLACEMENT)
    .replace(PATH_SIGNATURE, PATH_SIGNATURE_REPLACEMENT)
}

/**
 * Adjust the runtime-context labels. Idempotent.
 * @param text - one runtime-context snapshot body.
 */
export function adjustContextLabels(text: string): string {
  let result = text
  for (const [from, to] of RUNTIME_LABELS) result = result.replace(from, to)
  return result
}

/** One projected message, as the adapter views it before serialization. */
interface ProjectedMessage {
  readonly role?: string
  readonly content: unknown
  readonly source?: { readonly kind?: unknown }
}

/**
 * Adjust every message that can carry the wording. Text blocks are rewritten in
 * place; unchanged messages keep their identity.
 * @param messages - the request's projected messages.
 */
export function adjustMessages<T extends ProjectedMessage>(messages: T[]): T[] {
  return messages.map((message) => {
    const adjust = message.role === 'system' || message.role === 'assistant'
      ? adjustPromptText
      : message.role === 'user' && message.source?.kind === 'runtime-context'
        ? adjustContextLabels
        : undefined
    if (adjust === undefined) return message
    const content = adjustContent(message.content, adjust)
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * Apply one adjustment to every text block, leaving other blocks untouched.
 * @param content - one message's content, as parts or a plain string.
 * @param adjust - the wording adjustment to apply.
 */
function adjustContent(content: unknown, adjust: (text: string) => string): unknown {
  if (typeof content === 'string') return adjust(content)
  if (!Array.isArray(content)) return content
  let changed = false
  const blocks = content.map((part) => {
    if (typeof part !== 'object' || part === null) return part
    const block = part as { type?: unknown, text?: unknown }
    if (block.type !== 'text' || typeof block.text !== 'string') return part
    const text = adjust(block.text)
    if (text === block.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? blocks : content
}

/**
 * Adjust one request's system prompt and messages.
 * @param options - the assembled request.
 */
export function adjustOptions<T extends { system?: string, messages: ProjectedMessage[] }>(options: T): T {
  const system = options.system === undefined ? {} : { system: adjustPromptText(options.system) }
  return { ...options, ...system, messages: adjustMessages(options.messages) }
}
