/**
 * Tencent CodeBuddy provider plugin for DeepSeek Harness.
 *
 * Registers one `codebuddy` route on `ctx.llm`, authorized by a browser OAuth
 * login rather than an API key, and serving the models CodeBuddy's own
 * (non-OpenAI) catalog endpoint reports.
 *
 * Sign in through the Web Settings → CodeBuddy page, or `npx dsh-codebuddy-login`
 * from a terminal. No API key is required, and the running harness picks the
 * credential up without a restart.
 *
 * @module dsh-llm-codebuddy
 */

import type { Context } from '@deepseek-ai/cordis'
import { CodeBuddyAdapter } from './adapter.js'
import type { CodeBuddyConnectionOptions } from './adapter.js'
import { CodeBuddyAuthService } from './auth-service.js'
import {
  CODEBUDDY_CHAT_BASE,
  CODEBUDDY_PROVIDER,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './constants.js'
import { CodeBuddySession } from './session.js'

export { CodeBuddyAdapter, httpErrorCode } from './adapter.js'
export type { CodeBuddyAdapterOptions, CodeBuddyConnectionOptions } from './adapter.js'
export { CodeBuddyAuthService, CODEBUDDY_AUTH_CHANNEL } from './auth-service.js'
export type {
  CodeBuddyAuthStatus,
  CodeBuddyLoginStart,
  CodeBuddyLoginPoll,
  CodeBuddyUsageResult,
  CodeBuddyUsageWindow,
} from './auth-service.js'
export { CodeBuddySession, NotLoggedInError } from './session.js'
export { login } from './login.js'
export type { LoginHooks, LoginResult } from './login.js'
export { clearStorage, getStoragePath, loadStorage, saveStorage } from './storage.js'
export type { CodeBuddyStorage } from './storage.js'
export { fetchUsage, fetchPersonalUsage, fetchEnterpriseUsage, parseUsage } from './usage.js'
export type { UsageSnapshot, UsageWindow } from './usage.js'
export * from './constants.js'
export { hasDisclosedCapacity } from './types.js'
export type * from './types.js'

/** Cordis plugin name. */
export const name = 'llm-codebuddy'

/** This plugin needs the LLM seam to register its route on. */
export const inject = ['llm']

// The module is deliberately exported as named members only, with no default
// export. Cordis's loader collapses a module via `exports.default ?? exports`,
// so a `export default apply` would make the plugin a bare function and discard
// `inject` and `name` alongside it — the mount then fails with `cannot get
// property "llm" without inject`.

/**
 * Plugin config. Every field is optional: the shipped defaults reach the public
 * CodeBuddy service, and there is no credential field at all by design — the
 * only way in is the browser login.
 */
export interface Config {
  /** Chat endpoint base; defaults to CodeBuddy's OpenAI-compatible route. */
  baseURL?: string
  /** Context capacity for a model the catalog does not size. */
  defaultContextWindow?: number
  /** Per-request output cap for a model the catalog does not cap. */
  defaultMaxTokens?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
}

/**
 * Validate and complete the raw config.
 *
 * Programmatic construction can bypass any schema, so bounds are judged here
 * and a bad value fails at load with the field named, rather than mid-request.
 * @param config - the raw entry config.
 * @returns the resolved connection facts.
 */
export function resolveConnectionOptions(config: Config = {}): CodeBuddyConnectionOptions {
  const positiveInteger = (value: number | undefined, field: string, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`dsh-llm-codebuddy: ${field} must be a positive integer`)
    }
    return value
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error('dsh-llm-codebuddy: streamIdleTimeoutMs must be a positive finite number')
  }
  const baseURL = config.baseURL ?? CODEBUDDY_CHAT_BASE
  if (baseURL.length === 0) {
    throw new Error('dsh-llm-codebuddy: baseURL must not be empty')
  }
  return {
    // A trailing slash would produce `//chat/completions`, which some gateways
    // route differently.
    baseURL: baseURL.replace(/\/+$/, ''),
    defaultContextWindow: positiveInteger(
      config.defaultContextWindow,
      'defaultContextWindow',
      DEFAULT_CONTEXT_WINDOW,
    ),
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, 'defaultMaxTokens', DEFAULT_MAX_TOKENS),
    streamIdleTimeoutMs,
  }
}

/** Mount the plugin: resolve config, then register the route. */
export function apply(ctx: Context, config: Config = {}): void {
  // Resolved once at load so a bad entry config fails loudly here; the thunk
  // keeps the adapter reading it per operation.
  const resolved = resolveConnectionOptions(config)
  const session = new CodeBuddySession(ctx.logger)
  const adapter = new CodeBuddyAdapter({ session, options: () => resolved })

  ctx.llm.registerAdapter([CODEBUDDY_PROVIDER], adapter)

  new CodeBuddyAuthService(ctx, session)

  // A signed-out mount is legitimate: the route registers, and the first
  // request explains how to sign in. Saying so once at load keeps that from
  // being a surprise at the first prompt.
  void session.isLoggedIn().then((loggedIn) => {
    if (loggedIn) return
    ctx.logger.info(
      'llm-codebuddy: no CodeBuddy session stored; sign in through the Settings'
      + ' → CodeBuddy page, or run `npx dsh-codebuddy-login` (no API key needed).',
    )
  }).catch(() => {
    // Reporting login state is advisory and must never fail the mount.
  })
}
