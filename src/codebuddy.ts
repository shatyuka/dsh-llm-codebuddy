/**
 * CodeBuddy control-plane client: the browser-OAuth handshake, token refresh,
 * and the non-OpenAI model catalog.
 *
 * Every call here speaks the `{code, msg, data}` envelope rather than HTTP
 * status alone, so a 200 carrying a non-zero `code` is a failure and is
 * reported as one. This module is transport-only: it holds no state and makes
 * no policy decisions, which keeps the login flow, the adapter, and the CLI
 * able to share it.
 *
 * @module dsh-llm-codebuddy/codebuddy
 */

import {
  AUTH_PENDING_CODE,
  CODEBUDDY_ENDPOINT,
  CODEBUDDY_IDE_VERSION,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_MS,
} from './constants.js'
import type {
  Account,
  AccountResponse,
  AuthState,
  AuthStateResponse,
  AuthToken,
  AuthTokenResponse,
  CodeBuddyConfig,
  ConfigResponse,
} from './types.js'

/** The identity facts CodeBuddy requires on every authenticated request. */
export interface CodeBuddyIdentity {
  accessToken: string
  domain: string
  uid: string
  enterpriseId?: string
  departmentFullName?: string
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Start a browser-login handshake.
 * @param signal - optional cancellation.
 * @returns the handshake state and the URL the user must open.
 * @throws Error when the service refuses or answers an unusable body.
 */
export async function requestAuthState(signal?: AbortSignal): Promise<AuthState> {
  const response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) {
    throw new Error(`CodeBuddy auth state request failed (HTTP ${response.status})`)
  }
  const body = await response.json() as AuthStateResponse
  if (body.code !== 0 || body.data === undefined) {
    throw new Error(`CodeBuddy auth state request failed: ${body.code} - ${body.msg}`)
  }
  return body.data
}

/**
 * Poll until the user finishes signing in in the browser.
 *
 * The service reports "not finished yet" as code {@link AUTH_PENDING_CODE},
 * which is the one code that continues the loop; anything else is a decided
 * outcome and ends it. A transport error also ends it, because a handshake
 * whose state may already be spent must not be retried silently.
 * @param state - the handshake id from {@link requestAuthState}.
 * @param signal - optional cancellation.
 * @returns the issued tokens, or `undefined` when the login failed or timed out.
 */
export async function pollAuthToken(state: string, signal?: AbortSignal): Promise<AuthToken | undefined> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(LOGIN_POLL_INTERVAL_MS, signal)
    let response: Response
    try {
      response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-No-Authorization': 'true',
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch {
      return undefined
    }
    if (!response.ok) continue
    const body = await response.json() as AuthTokenResponse
    if (body.code === AUTH_PENDING_CODE) continue
    if (body.code !== 0) return undefined
    return body.data
  }
  return undefined
}

/**
 * Read the signed-in account, whose uid and enterprise id become required
 * headers on every later request.
 * @param state - the handshake id the tokens were issued for.
 * @param accessToken - the freshly issued access token.
 * @param domain - the tenant domain the tokens were issued for.
 * @returns the account facts.
 * @throws Error when the service refuses or answers an unusable body.
 */
export async function getLoginAccount(
  state: string,
  accessToken: string,
  domain: string,
): Promise<Account> {
  const response = await fetch(
    `${CODEBUDDY_ENDPOINT}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-Domain': domain,
      },
    },
  )
  if (!response.ok) {
    throw new Error(`CodeBuddy login account request failed (HTTP ${response.status})`)
  }
  const body = await response.json() as AccountResponse
  if (body.code !== 0 || body.data === undefined) {
    throw new Error(`CodeBuddy login account request failed: ${body.code} - ${body.msg}`)
  }
  return normalizeAccount(body.data)
}

/**
 * Normalize an account so an empty-string field reads as absent.
 *
 * CodeBuddy's account reply emits empty strings (not omissions) for fields a
 * tenant does not disclose — e.g. an enterprise account carries `uin: ""`. The
 * whole downstream (storage, auth status, the settings UI) treats only
 * `undefined` as "not present", so an empty string would render an empty row.
 * Trimming once here covers every consumer without each re-checking.
 * @param account - the raw account from the wire.
 * @returns the account with empty optional string fields dropped.
 */
function normalizeAccount(account: Account): Account {
  const pick = (value: string | undefined): string | undefined =>
    value === undefined || value.length === 0 ? undefined : value
  return {
    uid: account.uid,
    nickname: account.nickname,
    ...pick(account.uin) === undefined ? {} : { uin: account.uin },
    ...pick(account.enterpriseId) === undefined ? {} : { enterpriseId: account.enterpriseId },
    ...pick(account.enterpriseName) === undefined ? {} : { enterpriseName: account.enterpriseName },
    ...pick(account.enterpriseUserName) === undefined ? {} : { enterpriseUserName: account.enterpriseUserName },
    ...pick(account.departmentFullName) === undefined ? {} : { departmentFullName: account.departmentFullName },
  }
}

/** Why a token refresh produced no new tokens. */
export type RefreshFailure =
  /** The service refused the refresh token: it is spent, revoked, or wrong. */
  | 'rejected'
  /**
   * The refresh request never reached a verdict — a transport fault, or a 5xx
   * from a gateway in front of the service. The stored credential may be
   * perfectly good, so this must not be reported as "sign in again".
   */
  | 'unreachable'

/** A refresh attempt's outcome: new tokens, or why none were issued. */
export type RefreshResult =
  | { ok: true, token: AuthToken }
  | { ok: false, reason: RefreshFailure }

/**
 * Exchange a refresh token for a new access token.
 *
 * A refusal and an unreachable service are kept distinct: the caller renders
 * "sign in again" for the first, but retrying is the remedy for the second, and
 * conflating them would tell a user with a healthy credential to re-authenticate
 * because their Wi-Fi blinked. Only a decided, non-retryable answer — a 4xx
 * other than 408/429, or a 200 envelope carrying a non-zero code — counts as
 * `rejected`; every other failure is `unreachable`.
 * @param identity - the current identity, including the access token being replaced.
 * @param refreshToken - the refresh token to spend.
 * @param signal - optional cancellation.
 * @returns the new tokens, or the reason none were issued.
 */
export async function refreshAccessToken(
  identity: CodeBuddyIdentity,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${identity.accessToken}`,
    'X-Domain': identity.domain,
    'X-User-Id': identity.uid,
    'X-Refresh-Token': refreshToken,
  }
  if (identity.enterpriseId !== undefined) headers['X-Enterprise-Id'] = identity.enterpriseId
  let response: Response
  try {
    response = await fetch(`${CODEBUDDY_ENDPOINT}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers,
      ...signal === undefined ? {} : { signal },
    })
  } catch {
    // No verdict was reached, so the credential is not implicated.
    return { ok: false, reason: 'unreachable' }
  }
  if (!response.ok) {
    // 408 and 429 are retryable by definition, and any 5xx is the service's
    // problem; everything else (401/403 included) means the token was refused.
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    return { ok: false, reason: retryable ? 'unreachable' : 'rejected' }
  }
  let body: AuthTokenResponse
  try {
    body = await response.json() as AuthTokenResponse
  } catch {
    // A 200 whose body cannot be read is a broken reply, not a refusal.
    return { ok: false, reason: 'unreachable' }
  }
  if (body.code !== 0 || body.data === undefined) return { ok: false, reason: 'rejected' }
  return { ok: true, token: body.data }
}

/** The catalog read failed at the transport or HTTP boundary. */
export class ConfigRequestError extends Error {
  constructor(detail: string, readonly status?: number, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'ConfigRequestError'
  }
}

/**
 * Read the CodeBuddy model catalog.
 *
 * This is the non-OpenAI-compatible half of the service and the reason this
 * plugin cannot be replaced by a generic OpenAI-compatible route: the reply
 * discloses per-model capability flags and sizes that a `GET /models` listing
 * does not.
 * @param identity - the signed-in identity.
 * @param signal - optional cancellation.
 * @returns the catalog.
 * @throws ConfigRequestError when the service refuses or answers an unusable
 *   body; its `status` is set for an HTTP refusal so the caller can tell an
 *   authentication rejection from a transient outage.
 */
export async function getConfig(
  identity: CodeBuddyIdentity,
  signal?: AbortSignal,
): Promise<CodeBuddyConfig> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent': `CodeBuddyIDE/${CODEBUDDY_IDE_VERSION} CodeBuddy/${CODEBUDDY_IDE_VERSION}`,
    'Authorization': `Bearer ${identity.accessToken}`,
    'X-Domain': identity.domain,
    'X-User-Id': identity.uid,
  }
  if (identity.enterpriseId !== undefined) headers['X-Enterprise-Id'] = identity.enterpriseId
  if (identity.departmentFullName !== undefined) {
    headers['X-Department-Info'] = identity.departmentFullName
  }
  let response: Response
  try {
    response = await fetch(`${CODEBUDDY_ENDPOINT}/v3/config`, {
      method: 'GET',
      headers,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    // The status stays undefined: no HTTP verdict was reached.
    throw new ConfigRequestError('CodeBuddy config request failed (transport)', undefined, { cause: error })
  }
  if (!response.ok) {
    throw new ConfigRequestError(`CodeBuddy config request failed (HTTP ${response.status})`, response.status)
  }
  const body = await response.json() as ConfigResponse
  if (body.code !== 0 || body.data === undefined) {
    throw new ConfigRequestError(`CodeBuddy config request failed: ${body.code} - ${body.msg}`)
  }
  return body.data
}
