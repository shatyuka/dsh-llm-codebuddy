/**
 * CodeBuddy as a `ctx.web` backend: search and fetch through the service's
 * `agenttool` plane.
 *
 * CodeBuddy already answers both capabilities for its own clients, so the
 * plugin reuses the credential it holds rather than asking for a second one.
 * This module owns only wire mapping and failure translation; provider
 * selection, the model-facing tool schemas, and result limits stay in `ctx.web`
 * and `dsh-tool-web`.
 *
 * @module dsh-llm-codebuddy/web
 */

import { HarnessError, isHarnessError } from '@deepseek-ai/dsh-llm'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { endpointOf } from './constants.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
import type { CodeBuddySession } from './session.js'
import type { AgentToolError, AgentToolFetchResponse, AgentToolSearchResponse } from './types.js'
import { uuidv7 } from './uuid.js'

/** Search provider id: the value `searchProvider` pins. */
export const CODEBUDDY_SEARCH_PROVIDER_ID = 'codebuddy-search'

/** Fetch provider id: the value `fetchProvider` pins. */
export const CODEBUDDY_FETCH_PROVIDER_ID = 'codebuddy-fetch'

/**
 * The most hits one search asks for.
 *
 * A bound this plugin sets, not one the service enforces: it accepts any
 * positive integer and caps the reply itself at about ten, so asking for more
 * only spends a larger request for the same sources.
 */
export const AGENT_TOOL_MAX_RESULTS = 10

/** Hits requested when the caller states no bound; the service's own default is five. */
export const AGENT_TOOL_DEFAULT_RESULTS = 5

const SEARCH_PATH = '/agenttool/v1/search'
const FETCH_PATH = '/agenttool/v1/webfetch'

/**
 * The service's URL-safety rejection.
 *
 * It answers this before retrieving anything, for a destination its policy
 * refuses (a private address, a `file:` URL), so it is the one refusal that
 * blames the request rather than the credential or the service.
 */
const CODE_UNSAFE_URL = 15018

/** A refusal that says the stored credential is no longer accepted. */
class CredentialRejectedError extends HarnessError {
  constructor(message: string) {
    super(message, 'WEB_PROVIDER_ERROR')
    this.name = 'CredentialRejectedError'
  }
}

/**
 * What every failure becomes.
 *
 * The seam's code vocabulary is open, but the shared values are what consumers
 * route on: `WEB_ABORTED` for cancellation, `WEB_BLOCKED_URL` for a destination
 * the service refused, and `WEB_PROVIDER_ERROR` for everything else.
 * @param error - the thrown value.
 * @param fallback - the message when the failure carries none of its own.
 * @returns the value to throw.
 */
function failureOf(error: unknown, fallback: string): unknown {
  if (isHarnessError(error)) return error
  const detail = error instanceof Error && error.message.length > 0 ? error.message : fallback
  return new HarnessError(detail, 'WEB_PROVIDER_ERROR', { cause: error })
}

/** Read a failure envelope, when the body is one. */
async function readError(response: Response): Promise<AgentToolError | undefined> {
  try {
    const body = await response.json() as AgentToolError
    return typeof body?.code === 'number' ? body : undefined
  } catch {
    // The fronting proxy refuses a bad credential with HTML rather than an
    // envelope; the status alone still identifies that case.
    return undefined
  }
}

/**
 * Turn a non-2xx reply into the error the seam reports.
 * @param response - the refused reply.
 * @param operation - what was being attempted, for the message.
 * @returns the error to throw.
 */
async function refusal(response: Response, operation: string): Promise<HarnessError> {
  const failure = await readError(response)
  const detail = failure?.msg === undefined || failure.msg.length === 0 ? '' : `: ${failure.msg}`
  if (failure?.code === CODE_UNSAFE_URL) {
    return new HarnessError(`CodeBuddy refused the URL${detail}`, 'WEB_BLOCKED_URL')
  }
  if (response.status === 401 || response.status === 403) {
    return new CredentialRejectedError(
      `CodeBuddy rejected the stored credential while trying to ${operation}`
      + ' — sign in again through Settings → CodeBuddy.',
    )
  }
  return new HarnessError(
    `CodeBuddy ${operation} failed (HTTP ${response.status})${detail}`,
    'WEB_PROVIDER_ERROR',
  )
}

/** The identity a call runs under, resolved fresh so a sign-in applies at once. */
interface Caller {
  identity: CodeBuddyIdentity
  headers: Record<string, string>
}

/**
 * Post one operation to the service and read its JSON reply.
 * @param caller - the identity and its headers.
 * @param path - the operation path, relative to the site's service root.
 * @param body - the request document.
 * @param operation - what is being attempted, for failure messages.
 * @param signal - optional cancellation.
 * @returns the parsed reply.
 */
async function post(
  caller: Caller,
  path: string,
  body: unknown,
  operation: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${endpointOf(caller.identity.site)}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      // A redirected POST would resend the query to whatever origin the reply
      // names; the chat request refuses the same thing for the same reason.
      redirect: 'error',
      headers: {
        ...caller.headers,
        'content-type': 'application/json',
        'accept': 'application/json',
        // The service logs these as conversation bookkeeping; a one-shot call
        // names itself so the request is attributable.
        'X-Request-ID': uuidv7(),
      },
      body: JSON.stringify(body),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted === true) {
      throw new HarnessError(`CodeBuddy ${operation} aborted by caller`, 'WEB_ABORTED', { cause: error })
    }
    throw new HarnessError(`CodeBuddy ${operation} request to ${url} failed`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (!response.ok) throw await refusal(response, operation)
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new HarnessError(`CodeBuddy ${operation} returned an unreadable body`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Resolve the caller for one operation, mapping a credential failure.
 *
 * A rejected credential is dropped from memory so the next call re-reads the
 * file a concurrent sign-in may have replaced; a transport fault says nothing
 * about the token and leaves it alone.
 * @param session - the session holding the credential.
 * @param operation - what is being attempted, for the failure message.
 * @returns the identity and headers to send with.
 */
async function callerOf(session: CodeBuddySession, operation: string): Promise<Caller> {
  try {
    const identity = await session.identity()
    return { identity, headers: await session.authHeaders(identity) }
  } catch (error) {
    throw failureOf(error, `CodeBuddy ${operation} requires signing in through Settings → CodeBuddy`)
  }
}

/**
 * Map the search reply onto citeable sources.
 *
 * A hit without a URL cannot be cited, and the seam's contract is that every
 * source has one, so those are dropped rather than given a placeholder.
 * @param body - the parsed reply.
 * @returns the sources, in service order.
 */
function sourcesOf(body: AgentToolSearchResponse): WebSearchSource[] {
  const items = Array.isArray(body.results) ? body.results : []
  const sources: WebSearchSource[] = []
  for (const item of items) {
    const url = item.url
    if (typeof url !== 'string' || url.length === 0) continue
    sources.push({
      url,
      ...typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {},
      // This plane discloses one excerpt, which is the display form; the longer
      // `summary` meant for model reading has no counterpart here.
      ...typeof item.snippet === 'string' && item.snippet.length > 0 ? { snippet: item.snippet } : {},
    })
  }
  return sources
}

/** The search picker's explanation while this backend is selected. */
const SEARCH_DESCRIPTION = {
  en: 'Results from CodeBuddy search.',
  zh: '由 CodeBuddy 搜索返回结果。',
} as const

/** The fetch picker's explanation while this backend is selected. */
const FETCH_DESCRIPTION = {
  en: 'Page text from CodeBuddy retrieval.',
  zh: '由 CodeBuddy 获取网页正文。',
} as const

/** The search backend: CodeBuddy's search plane behind `ctx.web`. */
export class CodeBuddyWebSearchProvider implements WebSearchProvider {
  readonly id = CODEBUDDY_SEARCH_PROVIDER_ID
  readonly title = 'CodeBuddy Web Search'
  readonly description = SEARCH_DESCRIPTION

  constructor(private readonly session: CodeBuddySession) {}

  /**
   * Always usable as a backend; the credential question belongs to {@link ready}.
   *
   * The seam calls this synchronously and forbids network access, but the
   * session reads its credential from disk, so answering here would mean
   * blocking I/O. Official providers answer `available()` from settings they
   * already hold; this plugin holds no such copy, so it defers the check.
   */
  available(): boolean {
    return true
  }

  /**
   * Whether a request on this route could authenticate.
   *
   * `isUsable()` rather than `isLoggedIn()`: a stored credential whose refresh
   * token also expired still counts as signed in, yet every call fails — this
   * is exactly the state that must not advertise the tool.
   * @param _llmProvider - the route asking, which cannot matter here: one
   *   CodeBuddy credential serves every route, so readiness is route-blind.
   */
  async ready(_llmProvider: string | undefined): Promise<boolean> {
    return await this.session.isUsable()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const caller = await callerOf(this.session, 'search')
    const body = {
      query: request.query,
      type: 'text2text',
      max_results: Math.min(request.maxResults ?? AGENT_TOOL_DEFAULT_RESULTS, AGENT_TOOL_MAX_RESULTS),
    }
    let reply: AgentToolSearchResponse
    try {
      reply = await post(caller, SEARCH_PATH, body, 'search', signal) as AgentToolSearchResponse
    } catch (error) {
      if (error instanceof CredentialRejectedError) this.session.invalidate()
      throw error
    }
    // The seam cuts `sources` to `maxResults` and reports the cut itself, so
    // this provider never claims a truncation of its own.
    return { sources: sourcesOf(reply), truncated: false }
  }
}

/** The fetch backend: CodeBuddy's retrieval plane behind `ctx.web`. */
export class CodeBuddyWebFetchProvider implements WebFetchProvider {
  readonly id = CODEBUDDY_FETCH_PROVIDER_ID
  readonly title = 'CodeBuddy Web Fetch'
  readonly description = FETCH_DESCRIPTION

  constructor(private readonly session: CodeBuddySession) {}

  /** Always usable as a backend; see the search provider for why. */
  available(): boolean {
    return true
  }

  /**
   * Whether a fetch on this route could authenticate; see the search provider.
   * @param _llmProvider - the route asking; route-blind for the same reason.
   */
  async ready(_llmProvider: string | undefined): Promise<boolean> {
    return await this.session.isUsable()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const caller = await callerOf(this.session, 'fetch')
    let reply: AgentToolFetchResponse
    try {
      reply = await post(caller, FETCH_PATH, { url: request.url }, 'fetch', signal) as AgentToolFetchResponse
    } catch (error) {
      if (error instanceof CredentialRejectedError) this.session.invalidate()
      throw error
    }
    return {
      url: typeof reply.url === 'string' && reply.url.length > 0 ? reply.url : request.url,
      // The target page's status: the service reports it even when the envelope
      // itself answered 200.
      statusCode: typeof reply.status_code === 'number' ? reply.status_code : 200,
      // The service returns rendered Markdown, so this is never the HTML arm.
      body: { kind: 'text', content: typeof reply.content === 'string' ? reply.content : '' },
      truncated: reply.truncated === true,
    }
  }
}
