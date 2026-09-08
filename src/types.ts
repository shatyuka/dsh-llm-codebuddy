/**
 * Wire shapes this plugin reads, on two unrelated protocols.
 *
 * The CodeBuddy control plane (`/v2/plugin/auth/*`, `/v3/config`) wraps every
 * reply in `{code, msg, requestId, data}` and is NOT OpenAI-compatible — which
 * is the reason this plugin exists rather than a plain OpenAI-compatible route.
 * The chat plane (`/v2/chat/completions`) is OpenAI-compatible, so its chunk
 * shape is the familiar one.
 *
 * @module dsh-llm-codebuddy/types
 */

/** Envelope every CodeBuddy control-plane reply carries. */
export interface ResponseBase {
  code: number
  msg: string
  requestId: string
}

/** A started browser-login handshake. */
export interface AuthState {
  /** Opaque handshake id; correlates the browser session with the token poll. */
  state: string
  /** URL the user opens to sign in. */
  authUrl: string
}

export interface AuthStateResponse extends ResponseBase {
  data?: AuthState
}

/** Tokens issued once the browser login completes. */
export interface AuthToken {
  accessToken: string
  /** Access-token lifetime in seconds. */
  expiresIn: number
  refreshToken: string
  /** Refresh-token lifetime in seconds. */
  refreshExpiresIn: number
  /** Tenant domain that must be echoed on every later request. */
  domain: string
}

export interface AuthTokenResponse extends ResponseBase {
  data?: AuthToken
}

/** The signed-in identity; its fields become required request headers. */
export interface Account {
  uid: string
  nickname: string
  /** Tencent user identity number (e.g. QQ openid), when the account discloses one. */
  uin?: string
  enterpriseId?: string
  /** Enterprise display name, when the account is an enterprise tenant. */
  enterpriseName?: string
  /** Enterprise user name (the account's name within the tenant). */
  enterpriseUserName?: string
  departmentFullName?: string
}

export interface AccountResponse extends ResponseBase {
  data?: Account
}

/**
 * Reasoning metadata CodeBuddy discloses for one model. The effort ids are the
 * provider's own vocabulary ("low", "high", "xhigh", "max"); they are passed
 * through verbatim rather than mapped, so a level the catalog adds later needs
 * no code change.
 *
 * `supportedEfforts` is genuinely optional: `auto` ships a reasoning block that
 * declares an active `effort` but no selectable list at all.
 */
export interface CodeBuddyReasoning {
  /** Selectable levels, when this model discloses a choice. */
  supportedEfforts?: string[]
  /** Level applied when the caller picks none. */
  defaultEffort?: string
  /** Level currently active server-side; a fallback default source. */
  effort?: string
  /** Whether thinking can be turned off entirely. */
  canDisableThinking?: boolean
  summary?: string
}

/**
 * One model as CodeBuddy describes it. This is the CodeBuddy catalog shape,
 * disclosing capability flags and sizes alongside the OpenAI fields.
 */
export interface CodeBuddyModel {
  id: string
  name: string
  /** Credit/quota label CodeBuddy shows beside the model name. */
  credits?: string
  /** Opaque tags ("craft") and `badge:<label>:#<RRGGBB>` colored badges. */
  tags?: string[]
  /** Locale-specific model description, when disclosed. */
  descriptionZh?: string
  descriptionEn?: string
  /** Combined request/response context capacity. */
  maxAllowedSize?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportsToolCall?: boolean
  supportsReasoning?: boolean
  /** Selectable thinking levels, when disclosed. */
  reasoning?: CodeBuddyReasoning
}

export interface CodeBuddyConfig {
  models: CodeBuddyModel[]
  /** Scheduled campaigns that attach a badge and hover text to models. */
  modelPromotions?: CodeBuddyModelPromotion[]
}

/**
 * One scheduled campaign from the CodeBuddy config: a colored badge plus hover
 * text attached to every model in {@link modelIds} while its schedule is
 * active.
 */
export interface CodeBuddyModelPromotion {
  id: string
  /** Whether the campaign is currently switched on service-side. */
  enabled?: boolean
  /** Higher wins when several campaigns are active on one model. */
  priority?: number
  modelIds?: string[]
  badge?: {
    /** Hex color the badge pill renders in. */
    color?: string
    label?: string
    /**
     * When the badge is shown: "activeOnly" (default) only while the schedule
     * is active; "always" on every schedule state.
     */
    display?: 'activeOnly' | 'always'
  }
  hover?: {
    textZh?: string
    textEn?: string
  }
  schedule?: {
    /** IANA timezone the daily windows are evaluated in. */
    timezone?: string
    /** ISO-8601 instant the campaign starts at. */
    validFrom?: string
    /** ISO-8601 instant the campaign ends at. */
    validUntil?: string
    /** "HH:mm" windows, inclusive start and exclusive end. */
    daily?: { start: string, end: string }[]
  }
}

/**
 * Whether the catalog disclosed the capacities the harness requires.
 *
 * The harness needs a positive `contextWindow` and output cap for every model
 * it offers, and CodeBuddy omits both on entries that are not chat models
 * (completion, rewrite/jump, image generation). Inventing numbers for those
 * would put unusable models in the picker sized by guesswork, so callers drop
 * them instead. Kept here, beside the wire type, so the listing and the resolve
 * path cannot disagree about which entries are offerable.
 * @param model - one catalog entry.
 * @returns true when both capacities are present and positive.
 */
export function hasDisclosedCapacity(model: CodeBuddyModel): boolean {
  return model.maxAllowedSize !== undefined && model.maxAllowedSize > 0
    && model.maxOutputTokens !== undefined && model.maxOutputTokens > 0
}

/**
 * Minutes-past-midnight of one "HH:mm" window edge, or undefined when the
 * value is malformed. Hours run 0–23 and minutes 0–59, matching the CodeBuddy
 * IDE's own parser.
 */
function timeToMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  const hours = match === null ? undefined : Number.parseInt(match[1] ?? '', 10)
  const minutes = match === null ? undefined : Number.parseInt(match[2] ?? '', 10)
  if (hours === undefined || Number.isNaN(hours) || minutes === undefined || Number.isNaN(minutes)) return undefined
  if (hours > 23 || minutes > 59) return undefined
  return 60 * hours + minutes
}

/**
 * Whether `now` (minutes past midnight) is inside one `[start, end)` window.
 * A zero-length window covers the whole day, and a window whose end is earlier
 * than its start wraps past midnight.
 */
function inDailyWindow(now: number, start: number, end: number): boolean {
  if (start === end) return true
  if (end > start) return now >= start && now < end
  return now >= start || now < end
}

/**
 * Minutes past midnight right now in `timezone` (IANA), falling back to the
 * local clock when the timezone is unknown to `Intl`.
 */
function nowMinutesIn(timezone: string | undefined): number {
  let text: string
  try {
    // `hourCycle: 'h23'` keeps midnight at "00:00" — plain `hour12: false`
    // renders "24:00" on some ICU builds, which would read as minute 1440.
    text = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      ...(timezone === undefined ? {} : { timeZone: timezone }),
    }).format(new Date())
  } catch {
    text = ''
  }
  const match = /^(\d{2}):(\d{2})$/.exec(text)
  if (match === null) {
    const local = new Date()
    return 60 * local.getHours() + local.getMinutes()
  }
  return 60 * Number.parseInt(match[1] ?? '0', 10) + Number.parseInt(match[2] ?? '0', 10)
}

/**
 * Whether one campaign's schedule currently covers the moment, mirroring the
 * CodeBuddy IDE's own evaluation: a disabled campaign never runs; a missing
 * schedule always does; `validFrom`/`validUntil` bound the whole campaign by
 * absolute instant, and `daily` windows are `[start, end)` ranges in the
 * schedule's timezone (a malformed window edge drops that window).
 * @param promotion - one campaign entry.
 * @param now - the instant to test against (defaults to the current time).
 * @returns true when the campaign is active.
 */
export function isPromotionActive(promotion: CodeBuddyModelPromotion, now: number = Date.now()): boolean {
  if (promotion.enabled === false) return false
  const schedule = promotion.schedule
  if (schedule === undefined) return true
  if (schedule.validFrom !== undefined) {
    const from = Date.parse(schedule.validFrom)
    if (!Number.isNaN(from) && now < from) return false
  }
  if (schedule.validUntil !== undefined) {
    const until = Date.parse(schedule.validUntil)
    if (!Number.isNaN(until) && now >= until) return false
  }
  if (schedule.daily !== undefined && schedule.daily.length > 0) {
    const nowMinutes = nowMinutesIn(schedule.timezone)
    const inSomeWindow = schedule.daily.some((window) => {
      const start = timeToMinutes(window.start)
      const end = timeToMinutes(window.end)
      return start !== undefined && end !== undefined && inDailyWindow(nowMinutes, start, end)
    })
    if (!inSomeWindow) return false
  }
  return true
}

export interface ConfigResponse extends ResponseBase {
  data?: CodeBuddyConfig
}

/** Error body an OpenAI-compatible chat endpoint returns on a non-2xx reply. */
export interface WireError {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

/** Usage block of an OpenAI-compatible stream. */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One streamed tool-call fragment. */
export interface WireToolCall {
  index: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

/** One OpenAI-compatible stream chunk. */
export interface WireChunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: WireToolCall[] | null
    } | null
    finish_reason?: string | null
  }[] | null
  /**
   * Present but explicitly `null` on every non-final chunk, so consumers must
   * test for null rather than only `undefined`.
   */
  usage?: WireUsage | null
}

/** One wire message sent to the chat endpoint. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string, arguments: string }
  }[]
}

/** One tool schema sent to the chat endpoint. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** The chat-completions request body. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options?: { include_usage: boolean }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
  /** OpenAI-compatible thinking level; CodeBuddy's own effort vocabulary. */
  reasoning_effort?: string
}
