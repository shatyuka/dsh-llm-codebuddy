/**
 * Durable preference contract shared by both halves: the Host registers the
 * namespace schema, the browser binds the same namespace. The section is flat
 * because `set`/`unset` address top-level fields only.
 *
 * @module dsh-llm-codebuddy/settings
 */

/** Settings namespace this plugin owns in the user-settings document. */
export const CODEBUDDY_SETTINGS_NAMESPACE = 'llm-codebuddy'

/** Field: whether the sidebar foot renders the allowance indicator. */
export const SHOW_USAGE_FIELD = 'showUsage'

/** Field: optional custom quota cap, overriding the meter's reported limit. */
export const CUSTOM_LIMIT_FIELD = 'customLimit'

/** Field: unit the custom quota cap is entered and displayed in. */
export const CUSTOM_LIMIT_UNIT_FIELD = 'customLimitUnit'

/** Field: used-percentage at which the indicator fill turns the danger color. */
export const DANGER_PCT_FIELD = 'dangerPct'

/** Default for {@link SHOW_USAGE_FIELD}: the indicator shows unless hidden. */
export const DEFAULT_SHOW_USAGE = true

/** Default for {@link DANGER_PCT_FIELD}. */
export const DEFAULT_DANGER_PCT = 90

/**
 * Smallest accepted {@link CUSTOM_LIMIT_FIELD}.
 *
 * Zero is a real budget of zero — distinct from an absent field ("follow the
 * meter") — so the browser renders an unset cap as an empty input and a zero
 * cap as `0`.
 */
export const CUSTOM_LIMIT_MIN = 0

/**
 * Units the custom cap may be expressed in.
 *
 * Only `credit` crosses the RPC boundary or reaches the durable document; the
 * currencies are a browser-side presentation choice, converted in the client.
 */
export type CreditUnit = 'credit' | 'usd' | 'cny'

/** Every {@link CreditUnit}, in the order a selector offers them. */
export const CREDIT_UNITS = ['credit', 'cny', 'usd'] as const satisfies readonly CreditUnit[]

/** Default for {@link CUSTOM_LIMIT_UNIT_FIELD}: the meter's own unit. */
export const DEFAULT_CREDIT_UNIT: CreditUnit = 'credit'

/** Whether a value is one of {@link CREDIT_UNITS}. */
export function isCreditUnit(value: unknown): value is CreditUnit {
  return typeof value === 'string' && (CREDIT_UNITS as readonly string[]).includes(value)
}

/** Smallest accepted {@link DANGER_PCT_FIELD}. */
export const DANGER_PCT_MIN = 1

/** Largest accepted {@link DANGER_PCT_FIELD}. */
export const DANGER_PCT_MAX = 100

/**
 * The durable CodeBuddy section. `customLimit` stays optional on purpose: an
 * absent field means "follow the meter's limit", not a zero budget.
 *
 * Every amount here is in **credits** — the unit field only says how the
 * browser renders and accepts that one figure, so the Host never performs a
 * currency conversion.
 */
export interface CodeBuddySettings {
  /** Whether the sidebar foot renders the allowance indicator. */
  showUsage: boolean
  /** Custom quota cap, when the user set one. Always credits, never a currency. */
  customLimit?: number
  /** Unit {@link customLimit} is entered and displayed in. */
  customLimitUnit: CreditUnit
  /** Used-percentage at which the indicator fill turns the danger color. */
  dangerPct: number
}

/** One top-level field of the durable section; the unit of a scope write. */
export type CodeBuddySettingsField = keyof CodeBuddySettings
