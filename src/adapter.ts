/**
 * `CodeBuddyAdapter`: fetch + SSE against CodeBuddy's OpenAI-compatible chat
 * route, with identity and the model catalog resolved from the OAuth session.
 *
 * The split matters: the chat plane is OpenAI-compatible, but the catalog plane
 * is not, so models are described from CodeBuddy's own `/v3/config` reply — that
 * is where per-model tool-call, reasoning, image, and size facts come from. No
 * API key exists anywhere in this class; every request is authorized by the
 * browser-minted bearer token the session refreshes.
 *
 * @module dsh-llm-codebuddy/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  CODEBUDDY_DISPLAY_NAME,
  CODEBUDDY_IDE_USER_AGENT,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  CODE_NO_QUOTA,
  CODE_NO_TEAM_QUOTA,
  endpointOf,
} from './constants.js'
import { NotLoggedInError, SessionUnavailableError } from './session.js'
import type { CodeBuddySession } from './session.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
import { wordingKeys } from './locale.js'
import { parseSse } from './sse.js'
import type { AttachmentReader } from './serialize.js'
import { serializeRequest } from './serialize.js'
import { translate } from './translate.js'
import { hasDisclosedCapacity } from './types.js'
import type { CodeBuddyModel, WireError } from './types.js'

/** Connection facts the registering plugin resolves and the adapter trusts. */
export interface CodeBuddyConnectionOptions {
  /** Chat endpoint base override; omit to follow the credential's site. */
  baseURL?: string
  /** Context capacity used when the catalog does not size a model. */
  defaultContextWindow: number
  /** Per-request output cap used when the catalog does not cap a model. */
  defaultMaxTokens: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Retry policy captured with the route registration. */
  retryPolicy?: ResolvedRetryPolicy
}

/** Constructor options: the session plus the per-operation connection thunk. */
export interface CodeBuddyAdapterOptions {
  session: CodeBuddySession
  options: () => CodeBuddyConnectionOptions
  /** Resolves the durable attachment store, when the host provides one. */
  resolveAttachments?: () => AttachmentReader | undefined
  /**
   * The language in effect, asked again on each failure so a change needs no
   * re-registration. A BCP 47 tag; absence means English.
   */
  language?: () => string | undefined
}

/** Parse a `retry-after` header into milliseconds, when it carries a usable delay. */
function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-requestid')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/** Whether any message in the conversation carries retained image content. */
function messagesHaveRetainedImage(messages: readonly RequestMessage[]): boolean {
  // Offloaded occurrences project to placeholder text in the serializer, so
  // they read no bytes; only a retained occurrence needs the attachment store.
  return messages.some(message => message.content.some(block =>
    block.type === 'image' && block.offloaded !== true))
}

/**
 * The first entry that carries non-blank text.
 *
 * The type test is load-bearing, not defensive: a `displayMsg` lookup by the
 * reported locale id can reach an inherited `Object.prototype` member (report
 * `constructor` and the key names that function), and `trim` on a non-string
 * would throw here — discarding the envelope and downgrading the error code.
 */
function firstText(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** What one failure envelope is worth: a sentence to report, and the text a classifier reads. */
interface WireFailure {
  /** The service's own numeric error code, when one was carried. */
  code?: number
  /** The curated sentence in the reporting language, then the service's own fields. */
  message?: string
  /**
   * Every field the envelope carries, joined. The classifiers match English
   * identifiers as substrings, and each reads a different field: the curated
   * `displayMsg` holds the overflow phrasing, a provider `msg` the quota phrasing.
   */
  detail: string
}

/**
 * Read one failure envelope, or nothing when the body is unreadable — the status
 * still identifies that failure.
 * @param body - the parsed error body.
 * @param language - the language to report the service's wording in.
 */
function readWireFailure(body: WireError, language: string | undefined): WireFailure {
  const provider = body.extError
  const display = body.displayMsg
  const compatible = body.error
  const code = failureCode(body)
  // The reported locale id names the key directly; English stands as the
  // service's own default.
  const curated = firstText([
    ...wordingKeys(language).map(key => display?.[key]),
    display?.en,
    display?.zh,
  ])
  const message = curated ?? firstText([
    body.msg,
    provider?.message,
    compatible?.message,
    // The nested envelope is last: it is CodeBuddy's own shape and the only
    // place a refused chat request states its reason, but a real OpenAI
    // `{error:{message}}` has no `data` and must keep using the flat field.
    compatible?.data?.msg,
  ])
  const detail = [
    body.code === undefined ? undefined : String(body.code),
    body.msg,
    provider?.code,
    provider?.type,
    provider?.param,
    provider?.message,
    display?.en,
    display?.zh,
    display?.['zh-hant'],
    compatible?.code,
    compatible?.type,
    compatible?.message,
    compatible?.data?.code === undefined ? undefined : String(compatible.data.code),
    compatible?.data?.msg,
  ].filter(value => value !== undefined && value.length > 0).join(' ')
  return {
    ...message === undefined ? {} : { message },
    detail,
    ...code === undefined ? {} : { code },
  }
}

/**
 * The service's own numeric error code from one failure envelope.
 *
 * Read from every field that carries one, nested envelope included: a refused
 * chat request answers `{error:{data:{code}}}`, so the flat `code` is absent
 * there. The first finite number wins, and an unreadable one is skipped rather
 * than read as `NaN`.
 * @param body - the parsed error body.
 * @returns the code, when the envelope carried a usable one.
 */
function failureCode(body: WireError): number | undefined {
  for (const value of [body.code, body.error?.data?.code]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Map an HTTP status onto a stable harness error code.
 * @param status - the non-2xx status.
 * @param detail - every error wording the reply carried, when readable.
 * @param code - the service's own numeric error code, when the body carried one.
 * @returns the normalized code.
 */
export function httpErrorCode(status: number, detail?: string, code?: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  const text = detail ?? ''
  if (code === CODE_NO_QUOTA || code === CODE_NO_TEAM_QUOTA) return QUOTA_EXCEEDED_CODE
  if (isQuotaExceededError(text)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(text)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Build the harness model descriptor for one catalog entry. */
function modelInfo(provider: string, model: CodeBuddyModel): LlmModelInfo {
  // The credit label goes in `description` — "user-facing distinction from
  // otherwise similar models" — rather than being spliced into `name`. Keeping
  // `name` as CodeBuddy's own name means a credit change (which CodeBuddy can
  // make at any time) no longer looks like the model was renamed. Note this is
  // display metadata only: the harness does not route or budget on it.
  //
  // The wire value is already a formatted multiplier ("x3.33", "x0.05"), so it
  // is shown bare: it is the whole point of the field here, and the selector
  // renders `description` on one nowrap line with an ellipsis, so every extra
  // word costs visible information. `x0.00` is kept rather than hidden — a
  // zero-rate model is a fact worth showing, and suppressing it would make the
  // field look broken.
  const credits = model.credits?.trim()
  return {
    provider,
    id: model.id,
    name: model.name,
    ...credits === undefined || credits.length === 0 ? {} : { description: credits },
    inputModalities: model.supportsImages === true ? ['text', 'image'] : ['text'],
  }
}

/**
 * The catalog's sampling temperature, when it disclosed a usable one.
 *
 * The catalog arrives as remote JSON, so the field is checked rather than
 * trusted: a non-number would otherwise be forwarded onto the wire, where the
 * service would reject the whole request.
 */
function catalogTemperature(model: CodeBuddyModel | undefined): number | undefined {
  const value = model?.temperature
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Human-readable names for CodeBuddy's effort vocabulary. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/**
 * Translate CodeBuddy's disclosed thinking levels into harness reasoning
 * metadata, or `undefined` when the model does not reason at all.
 *
 * The levels are passed through as opaque ids rather than mapped onto a fixed
 * scale: they are exactly what the chat endpoint accepts as `reasoning_effort`,
 * so a level CodeBuddy adds later needs no code change here. An unrecognized id
 * still gets a readable name from its own spelling.
 *
 * A model that reasons without disclosing a selectable list is still declared:
 * it thinks at one level, and that level is what its requests carry anyway.
 * Declaring nothing would drop the level from every request and make the
 * harness reject a caller who named it.
 */
function reasoningInfo(model: CodeBuddyModel): LlmModelReasoningInfo | undefined {
  const reasoning = model.reasoning
  const capable = model.supportsReasoning === true
    || model.onlyReasoning === true
    || (reasoning?.supportedEfforts?.length ?? 0) > 0
  if (!capable) return undefined

  const seen = new Set<string>()
  const efforts: LlmReasoningEffortInfo[] = []
  const declare = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    efforts.push({ id: ReasoningEffortId(id), name: EFFORT_NAMES[id] ?? id })
  }
  for (const raw of reasoning?.supportedEfforts ?? []) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id.length > 0) declare(id)
  }

  // The level a request carries when the caller picks none: the active `effort`
  // first, then `defaultEffort`, then the first selectable one. Declared into
  // the list because the harness rejects a default it cannot find there, and a
  // named level is how a model says it always thinks that way.
  const active = reasoning?.effort?.trim()
  const preferred = reasoning?.defaultEffort?.trim()
  const resolved = active !== undefined && active.length > 0 ? active
    : preferred !== undefined && preferred.length > 0 ? preferred
      : efforts[0]?.id
  if (resolved === undefined) return undefined
  declare(resolved)

  // Always set: the level is what the model would use regardless, and the
  // harness materializes it into every request that omits a choice.
  return { efforts, defaultEffort: ReasoningEffortId(resolved) }
}

/**
 * The CodeBuddy adapter. One instance serves the single `codebuddy` route and
 * every model that route's catalog reports.
 */
export class CodeBuddyAdapter extends LlmAdapter {
  constructor(private readonly config: CodeBuddyAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: CODEBUDDY_DISPLAY_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.config.session.modelsOrEmpty()
    // Entries whose capacities the catalog withholds are left out rather than
    // sized by invention: CodeBuddy omits them on its non-chat models, so
    // offering them would put unusable choices in the picker. An id dropped
    // here stays routable through `resolveModel` for anyone who names it
    // explicitly.
    return models
      .filter(model => hasDisclosedCapacity(model))
      .map(model => modelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const models = await this.config.session.modelsOrEmpty(signal)
    const entry = models.find(candidate => candidate.id === model)
    if (entry === undefined) {
      // An unlisted id is still routable — the catalog is advisory — but
      // nothing is known about it, so the conservative text-only shape is
      // declared rather than letting the host persist images the serializer
      // would then reject.
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: connection.defaultContextWindow },
        defaultMaxTokens: connection.defaultMaxTokens,
      }
    }
    const reasoning = reasoningInfo(entry)
    return {
      ...modelInfo(provider, entry),
      context: {
        contextWindow: entry.maxAllowedSize !== undefined && entry.maxAllowedSize > 0
          ? entry.maxAllowedSize
          : connection.defaultContextWindow,
      },
      defaultMaxTokens: entry.maxOutputTokens !== undefined && entry.maxOutputTokens > 0
        ? entry.maxOutputTokens
        : connection.defaultMaxTokens,
      // Declaring reasoning is only safe because `stream()` forwards the level
      // as `reasoning_effort`: the harness materializes a declared default into
      // every request, so a declared-but-unsent capability would be a control
      // that silently does nothing.
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per call, before the first yield: the endpoint facts and
    // the identity freeze together, so a token refreshed mid-stream cannot be
    // paired with a different generation's endpoint.
    const connection = this.config.options()
    // Resolved once: a concurrent login or logout between two resolutions could
    // pair one site's host with the other site's token.
    let identity: CodeBuddyIdentity
    let headers: Record<string, string>
    try {
      identity = await this.config.session.identity()
      headers = await this.config.session.authHeaders(identity)
    } catch (error) {
      if (error instanceof NotLoggedInError) {
        throw new LlmError(error.message, 'MISSING_CREDENTIAL', { cause: error })
      }
      if (error instanceof SessionUnavailableError) {
        // The credential was never judged — the refresh endpoint was
        // unreachable. `TRANSPORT` is in the default retryable set, so the
        // harness retries instead of telling the user to sign in again.
        throw new LlmError(error.message, 'TRANSPORT', { cause: error })
      }
      throw error
    }

    const models = await this.config.session.modelsOrEmpty(options.signal)
    const entry = models.find(candidate => candidate.id === options.model)
    const supportsImages = entry?.supportsImages === true

    if (options.tools !== undefined && options.tools.length > 0 && entry?.supportsToolCall === false) {
      throw new LlmError(
        `CodeBuddy model "${options.model}" does not support tool calls`,
        'UNSUPPORTED_OPTION',
      )
    }

    if (supportsImages && messagesHaveRetainedImage(options.messages)) {
      // Image content is only serializable through the durable attachment
      // service; a host without it would silently drop the pixels.
      if (this.config.resolveAttachments?.() === undefined) {
        throw new LlmError(
          'CodeBuddy image requests require the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }

    const body = await serializeRequest(
      options,
      supportsImages,
      this.config.resolveAttachments?.(),
      entry?.reasoning?.summary,
      catalogTemperature(entry),
    )
    // Serialized before the try so the transport label below covers only the
    // transport boundary.
    const payload = JSON.stringify(body)

    let response: Response
    // The credential's site decides the host; an explicit `baseURL` wins.
    const chatBase = connection.baseURL ?? `${endpointOf(identity.site)}/v2`
    try {
      response = await fetch(`${chatBase}/chat/completions`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          'user-agent': CODEBUDDY_IDE_USER_AGENT,
          ...options.sessionId === undefined ? {} : { 'X-Conversation-ID': options.sessionId },
          'X-Model-ID': options.model,
        },
        body: payload,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw new LlmError('CodeBuddy request aborted by caller', 'ABORTED', { cause: error })
      }
      // fetch reports every transport fault as a bare `TypeError: fetch
      // failed`; the endpoint and the chained cause are what make it
      // diagnosable.
      throw new LlmError(
        `CodeBuddy request to ${chatBase} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `CodeBuddy API error (HTTP ${response.status})`
      let failure: WireFailure = { detail: '' }
      // Asked outside the parse block: a language source that throws must not be
      // mistaken for a malformed body, which would discard the envelope.
      let language: string | undefined
      try {
        language = this.config.language?.()
      } catch {
        // The language is cosmetic; the failure is not.
      }
      try {
        failure = readWireFailure(await response.json() as WireError, language)
        if (failure.message !== undefined) message = failure.message
      } catch {
        // Only error-body parsing is swallowed: the status still identifies the
        // failure, so malformed JSON must not mask it.
      }
      if (response.status === 401 || response.status === 403) {
        // The stored token was rejected outright; drop it from memory so the
        // next call re-reads the file (a concurrent login may have replaced it)
        // instead of retrying a token already known to be refused.
        this.config.session.invalidate()
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, failure.detail, failure.code), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }

    if (response.body === null) {
      throw new LlmError('CodeBuddy API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body), options.tools)
  }
}

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS }
