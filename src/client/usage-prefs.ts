/**
 * Durable usage preferences: the view of the Host configuration form the
 * settings rows and the sidebar indicator read — optimistic writes, values
 * adopted from the Host, one shared subscription.
 *
 * @module dsh-llm-codebuddy/usage-prefs
 */

import { useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
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
} from '../settings.js'
import type { CodeBuddySettings, CreditUnit } from '../settings.js'

/** Shown before the Host answers or with no settings provider; matches the schema defaults. */
const FALLBACK: CodeBuddySettings = {
  showUsage: DEFAULT_SHOW_USAGE,
  customLimitUnit: DEFAULT_CREDIT_UNIT,
  dangerPct: DEFAULT_DANGER_PCT,
}

/**
 * Hold each field to its schema bound: a hand-edited document can carry an
 * unusable value, which is dropped (optional) or defaulted (required).
 */
function normalize(section: CodeBuddySettings): CodeBuddySettings {
  const { showUsage, customLimit, customLimitUnit, dangerPct } = section
  const next: CodeBuddySettings = {
    showUsage: typeof showUsage === 'boolean' ? showUsage : DEFAULT_SHOW_USAGE,
    // The unit only ever names a conversion the browser has; an unknown one
    // falls back to credits rather than rendering a figure in no unit at all.
    customLimitUnit: isCreditUnit(customLimitUnit) ? customLimitUnit : DEFAULT_CREDIT_UNIT,
    dangerPct: typeof dangerPct === 'number' && Number.isFinite(dangerPct)
      && dangerPct >= DANGER_PCT_MIN && dangerPct <= DANGER_PCT_MAX
      ? dangerPct
      : DEFAULT_DANGER_PCT,
  }
  if (typeof customLimit === 'number' && Number.isFinite(customLimit) && customLimit >= CUSTOM_LIMIT_MIN) {
    next.customLimit = customLimit
  }
  return next
}

/** Whether two resolved sections carry the same preferences. */
function equal(a: CodeBuddySettings, b: CodeBuddySettings): boolean {
  return a.showUsage === b.showUsage
    && a.customLimit === b.customLimit
    && a.customLimitUnit === b.customLimitUnit
    && a.dangerPct === b.dangerPct
}

/**
 * The preference surface: writes publish optimistically, then adopt whatever
 * the Host settled on, so a refusal heals into the stored value.
 */
export interface UsagePrefs {
  /** @returns the current preferences (stable reference until they change). */
  getSnapshot(): CodeBuddySettings
  /** @returns the disposer removing this listener. */
  subscribe(listener: () => void): () => void
  /**
   * Whether changes persist beyond this tab: false on a non-loopback Host,
   * where the settings transport stays process-local.
   */
  isPersistent(): boolean
  /** Show or hide the sidebar allowance indicator. */
  setShowUsage(value: boolean): void
  /** Set the custom quota cap; `undefined` follows the meter's reported limit. */
  setCustomLimit(value: number | undefined): void
  /**
   * Set the unit the custom quota cap is entered and displayed in. The stored
   * cap is untouched: it stays in credits and is merely re-rendered, so
   * switching units never re-scales the user's budget.
   */
  setCustomLimitUnit(value: CreditUnit): void
  /** Set the danger-color threshold; `undefined` restores the default. */
  setDangerPct(value: number | undefined): void
  /** Release the form subscription; called on plugin unload. */
  dispose(): void
}

/**
 * Build the preference surface over the plugin entry's configuration form.
 * @returns the surface shared by every reader in this tab.
 */
export function createUsagePrefs(form: ConfigForm<CodeBuddySettings>): UsagePrefs {
  const initial = form.getSnapshot().value
  let current: CodeBuddySettings = initial === undefined ? FALLBACK : normalize(initial)
  const listeners = new Set<() => void>()

  // `loading` counts as persistent: a notice before the first Host answer
  // would be noise. Only a settled non-writable form reports not persisted.
  const persistent = (): boolean => {
    const snapshot = form.getSnapshot()
    return snapshot.status === 'loading' || (snapshot.mode === 'host' && snapshot.writable)
  }
  let lastPersistent = persistent()

  const publish = (next: CodeBuddySettings): void => {
    if (equal(current, next)) return
    current = next
    for (const listener of [...listeners]) listener()
  }

  // The persistence flag publishes separately from the value: `writable` can
  // flip while the section is byte-identical (defaults, no user overrides).
  const adopt = (): void => {
    const snapshot = form.getSnapshot()
    if (snapshot.value !== undefined) publish(normalize(snapshot.value))
    const nextPersistent = persistent()
    if (nextPersistent !== lastPersistent) {
      lastPersistent = nextPersistent
      for (const listener of [...listeners]) listener()
    }
  }

  const unsubscribeForm = form.subscribe(adopt)

  const write = (optimistic: CodeBuddySettings, persist: () => Promise<boolean>): void => {
    publish(optimistic)
    void persist().then(adopt, adopt)
  }

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    isPersistent: () => lastPersistent,
    setShowUsage: (value) => {
      write({ ...current, showUsage: value }, () => form.set(SHOW_USAGE_FIELD, value))
    },
    setCustomLimit: (value) => {
      // Only key absence means "follow the meter" (`exactOptionalPropertyTypes`
      // distinguishes it from an explicit `undefined`), so a clear drops it.
      const next: CodeBuddySettings = {
        showUsage: current.showUsage,
        customLimitUnit: current.customLimitUnit,
        dangerPct: current.dangerPct,
      }
      if (value !== undefined) next.customLimit = value
      write(
        next,
        value === undefined
          ? () => form.unset(CUSTOM_LIMIT_FIELD)
          : () => form.set(CUSTOM_LIMIT_FIELD, value),
      )
    },
    setCustomLimitUnit: (value) => {
      // Skip the redundant round-trip; the store's equality check would
      // suppress the publish anyway.
      if (value === current.customLimitUnit) return
      write({ ...current, customLimitUnit: value }, () => form.set(CUSTOM_LIMIT_UNIT_FIELD, value))
    },
    setDangerPct: (value) => {
      write(
        { ...current, dangerPct: value ?? DEFAULT_DANGER_PCT },
        value === undefined
          ? () => form.unset(DANGER_PCT_FIELD)
          : () => form.set(DANGER_PCT_FIELD, value),
      )
    },
    dispose: () => {
      unsubscribeForm()
      listeners.clear()
    },
  }
}

/** The current preferences, re-rendering the caller on every change. */
export function useUsagePrefs(prefs: UsagePrefs): CodeBuddySettings {
  return useSyncExternalStore(prefs.subscribe, prefs.getSnapshot)
}

/** Whether edits persist beyond this tab, re-rendering the caller on flip. */
export function usePersistentPrefs(prefs: UsagePrefs): boolean {
  return useSyncExternalStore(prefs.subscribe, prefs.isPersistent)
}
