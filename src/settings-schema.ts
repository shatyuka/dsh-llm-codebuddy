/**
 * Durable preference fields the Web client edits.
 *
 * Only the Host composes these into its plugin Config (as volatile fields);
 * the browser receives the serialized envelope through the settings transport.
 *
 * @module dsh-llm-codebuddy/settings-schema
 */

import z from '@deepseek-ai/schemastery'
import {
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
  HIDDEN_MODELS_FIELD,
  MODEL_ORDER_FIELD,
  SHOW_USAGE_FIELD,
  defaultHiddenModels,
  defaultModelOrder,
} from './settings.js'
import type { CodeBuddySettings } from './settings.js'

/**
 * Bounds live in the schema (not a `validate` hook) so configuration forms can
 * render them and bad values are refused at the write. `customLimit` carries
 * no default: an absent field resolves to `undefined`, keeping "follow the
 * meter's limit" expressible. The two list fields default to empty: an absent
 * list is the catalog's own order and a fully visible menu, which is also what
 * `unset` restores.
 */
export const SettingsFields: {
  [K in keyof CodeBuddySettings]-?: z<CodeBuddySettings[K]>
} = {
  [SHOW_USAGE_FIELD]: z.boolean().default(DEFAULT_SHOW_USAGE),
  [CUSTOM_LIMIT_FIELD]: z.number().min(CUSTOM_LIMIT_MIN),
  [CUSTOM_LIMIT_UNIT_FIELD]: z.union(CREDIT_UNITS.map(unit => z.const(unit))).default(DEFAULT_CREDIT_UNIT),
  [DANGER_PCT_FIELD]: z.number().step(1).min(DANGER_PCT_MIN).max(DANGER_PCT_MAX).default(DEFAULT_DANGER_PCT),
  [MODEL_ORDER_FIELD]: z.array(z.string()).default(defaultModelOrder()),
  [HIDDEN_MODELS_FIELD]: z.array(z.string()).default(defaultHiddenModels()),
}
