import { describe, expect, it } from 'vitest'
import {
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
  HIDDEN_MODELS_FIELD,
  MODEL_ORDER_FIELD,
  SHOW_USAGE_FIELD,
  defaultHiddenModels,
  defaultModelOrder,
  isCreditUnit,
} from '../src/settings.js'

describe('settings vocabulary', () => {
  it('owns its own namespace so another plugin cannot collide', () => {
    expect(CODEBUDDY_SETTINGS_NAMESPACE).toBe('llm-codebuddy')
  })

  it('keeps field names distinct', () => {
    const fields = [
      SHOW_USAGE_FIELD,
      CUSTOM_LIMIT_FIELD,
      CUSTOM_LIMIT_UNIT_FIELD,
      DANGER_PCT_FIELD,
      MODEL_ORDER_FIELD,
      HIDDEN_MODELS_FIELD,
    ]
    expect(new Set(fields).size).toBe(fields.length)
  })

  it('ships a bounded danger threshold around the default', () => {
    expect(DEFAULT_DANGER_PCT).toBeGreaterThanOrEqual(DANGER_PCT_MIN)
    expect(DEFAULT_DANGER_PCT).toBeLessThanOrEqual(DANGER_PCT_MAX)
    expect(DANGER_PCT_MIN).toBe(1)
    expect(DANGER_PCT_MAX).toBe(100)
  })

  it('defaults the indicator to visible', () => {
    expect(DEFAULT_SHOW_USAGE).toBe(true)
  })

  it('allows a zero custom cap, which is a real budget of zero', () => {
    // Distinct from an absent field, which means "follow the meter".
    expect(CUSTOM_LIMIT_MIN).toBe(0)
  })
})

describe('list defaults', () => {
  it('defaults both model lists to empty', () => {
    expect(defaultModelOrder()).toEqual([])
    expect(defaultHiddenModels()).toEqual([])
  })

  it('returns a fresh array each call, since callers may mutate it', () => {
    const first = defaultModelOrder()
    const second = defaultModelOrder()
    expect(first).not.toBe(second)
    first.push('mutated')
    expect(defaultModelOrder()).toEqual([])
  })
})

describe('credit units', () => {
  it('offers credits first, with the meter unit as default', () => {
    expect(CREDIT_UNITS).toEqual(['credit', 'cny', 'usd'])
    expect(DEFAULT_CREDIT_UNIT).toBe('credit')
    expect(CREDIT_UNITS).toContain(DEFAULT_CREDIT_UNIT)
  })

  it('narrows only the declared units', () => {
    for (const unit of CREDIT_UNITS) expect(isCreditUnit(unit)).toBe(true)
    expect(isCreditUnit('eur')).toBe(false)
    expect(isCreditUnit('')).toBe(false)
    expect(isCreditUnit(undefined)).toBe(false)
    expect(isCreditUnit(null)).toBe(false)
    expect(isCreditUnit(['usd'])).toBe(false)
  })
})
