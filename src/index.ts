/**
 * Tencent CodeBuddy provider plugin for DeepSeek Harness.
 *
 * Registers one `codebuddy` route on `ctx.llm`, authorized by a browser OAuth
 * login rather than an API key, and serving the models CodeBuddy's own
 * (non-OpenAI) catalog endpoint reports.
 *
 * @module dsh-llm-codebuddy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { CodeBuddyAdapter } from './adapter.js'
import type { CodeBuddyConnectionOptions } from './adapter.js'
import { CodeBuddyAuthService } from './auth-service.js'
import {
  CODEBUDDY_PROVIDER,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './constants.js'
import { CodeBuddySession } from './session.js'
import { MessageLocale } from './locale.js'
import { SettingsFields } from './settings-schema.js'
import { SHOW_USAGE_FIELD, CUSTOM_LIMIT_FIELD, CUSTOM_LIMIT_UNIT_FIELD, DANGER_PCT_FIELD } from './settings.js'
import type { CreditUnit } from './settings.js'

export { CodeBuddyAdapter, httpErrorCode } from './adapter.js'
export type { CodeBuddyAdapterOptions, CodeBuddyConnectionOptions } from './adapter.js'
export { CodeBuddyAuthService, CODEBUDDY_AUTH_CHANNEL } from './auth-service.js'
export type {
  CodeBuddyAuthStatus,
  CodeBuddyLoginStart,
  CodeBuddyLoginPoll,
  CodeBuddyModelEntry,
  CodeBuddyModelsResult,
  CodeBuddyPromotionView,
  CodeBuddyUsageResult,
  CodeBuddyUsageWindow,
} from './auth-service.js'
export { CodeBuddySession, NotLoggedInError, SessionUnavailableError } from './session.js'
export { login } from './login.js'
export type { LoginHooks, LoginResult } from './login.js'
export { clearStorage, getStoragePath, loadStorage, saveStorage } from './storage.js'
export type { CodeBuddyStorage } from './storage.js'
export { fetchUsage, fetchPersonalUsage, fetchEnterpriseUsage, parseUsage } from './usage.js'
export type { UsageSnapshot, UsageWindow } from './usage.js'
export { ConfigRequestError } from './codebuddy.js'
export type { RefreshFailure, RefreshResult } from './codebuddy.js'
export * from './constants.js'
export { hasDisclosedCapacity } from './types.js'
export type * from './types.js'
export { MessageLocale, prefersChinese, wordingKeys } from './locale.js'
export {
  CODEBUDDY_SETTINGS_NAMESPACE,
  CREDIT_UNITS,
  CUSTOM_LIMIT_FIELD,
  CUSTOM_LIMIT_MIN,
  CUSTOM_LIMIT_UNIT_FIELD,
  DANGER_PCT_FIELD,
  DANGER_PCT_MAX,
  DANGER_PCT_MIN,
  DEFAULT_CREDIT_UNIT,
  DEFAULT_DANGER_PCT,
  DEFAULT_SHOW_USAGE,
  SHOW_USAGE_FIELD,
  isCreditUnit,
} from './settings.js'
export type { CodeBuddySettings, CodeBuddySettingsField, CreditUnit } from './settings.js'
export { SettingsFields } from './settings-schema.js'
export { usedPercent } from './quota.js'

/** Cordis plugin name. */
export const name = 'llm-codebuddy'

/** This plugin needs the LLM seam to register its route on. */
export const inject = ['llm']

// No default export on purpose: Cordis's loader collapses a module via
// `exports.default ?? exports`, which would discard `inject` and `name`.

/**
 * Plugin config. Route facts are ordinary entry config; the three usage
 * preference fields are `volatile`, so the Web settings forms own their
 * durable storage and edits apply without a reload.
 */
export const Config = z.object({
  /** Chat endpoint base override; omit to follow the credential's site. */
  baseURL: z.string(),
  /** Context capacity for a model the catalog does not size. */
  defaultContextWindow: z.number(),
  /** Per-request output cap for a model the catalog does not cap. */
  defaultMaxTokens: z.number(),
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: z.number(),
  /** Provider-owned retry policy; omission selects the harness defaults. */
  retryPolicy: RetryPolicySchema,
  [SHOW_USAGE_FIELD]: SettingsFields[SHOW_USAGE_FIELD].volatile(),
  [CUSTOM_LIMIT_FIELD]: SettingsFields[CUSTOM_LIMIT_FIELD].volatile(),
  [CUSTOM_LIMIT_UNIT_FIELD]: SettingsFields[CUSTOM_LIMIT_UNIT_FIELD].volatile(),
  [DANGER_PCT_FIELD]: SettingsFields[DANGER_PCT_FIELD].volatile(),
})

/** Untyped mirror of {@link Config}'s fields; see the field docs there. */
export interface Config {
  baseURL?: string
  defaultContextWindow?: number
  defaultMaxTokens?: number
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  showUsage?: boolean
  customLimit?: number
  customLimitUnit?: CreditUnit
  dangerPct?: number
}

/**
 * Validate and complete the raw config. Programmatic construction can bypass
 * any schema, so bounds are judged here and a bad value fails at load with the
 * field named, rather than mid-request.
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
  if (config.baseURL !== undefined && config.baseURL.length === 0) {
    throw new Error('dsh-llm-codebuddy: baseURL must not be empty')
  }
  return {
    // A trailing slash would produce `//chat/completions`, which some gateways
    // route differently.
    ...config.baseURL === undefined ? {} : { baseURL: config.baseURL.replace(/\/+$/, '') },
    defaultContextWindow: positiveInteger(
      config.defaultContextWindow,
      'defaultContextWindow',
      DEFAULT_CONTEXT_WINDOW,
    ),
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, 'defaultMaxTokens', DEFAULT_MAX_TOKENS),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-llm-codebuddy: retryPolicy'),
  }
}

/** How often the plugin re-reads the catalog to notice server-side edits, in ms. */
const CATALOG_POLL_INTERVAL_MS = 5 * 60 * 1000

/** Mount the plugin: resolve config, then register the route. */
export function apply(ctx: Context, config: Config = {}): void {
  // Resolved once at load so a bad entry config fails loudly here; the thunk
  // keeps the adapter reading it per operation.
  const resolved = resolveConnectionOptions(config)
  const session = new CodeBuddySession(ctx.logger)
  const messageLocale = new MessageLocale()
  const adapter = new CodeBuddyAdapter({
    session,
    options: () => resolved,
    resolveAttachments: () => ctx.get('attachments'),
    language: () => messageLocale.tag(),
  })

  ctx.llm.registerAdapter([CODEBUDDY_PROVIDER], adapter)

  // The Web client caches the catalog and refetches on
  // `llm/adapters-updated`, so a server-side edit would keep stale rows in the
  // picker without this republication.
  ctx.effect(() => session.onCatalogChange(() => {
    ctx.emit('llm/adapters-updated')
  }), 'dsh-llm-codebuddy: catalog change announcements')

  // Convergence for an open Web client that never reopens the menu: re-read
  // the catalog on its own TTL cadence and announce any change. `unref` keeps
  // the maintenance timer from holding the process alive.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void session.refreshCatalog()
    }, CATALOG_POLL_INTERVAL_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'dsh-llm-codebuddy: catalog change polling')

  new CodeBuddyAuthService(ctx, session, messageLocale)

  // A signed-out mount is legitimate; saying so once at load keeps the first
  // request's sign-in explanation from being a surprise.
  void session.isLoggedIn().then((loggedIn) => {
    if (loggedIn) return
    ctx.logger.info(
      'llm-codebuddy: no CodeBuddy session stored; sign in through the Settings'
      + ' → CodeBuddy page.',
    )
  }).catch(() => {
    // Reporting login state is advisory and must never fail the mount.
  })
}
