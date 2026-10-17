import { describe, expect, it } from 'vitest'
import { SettingsFields } from '../src/settings-schema.js'
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
  HIDDEN_MODELS_FIELD,
  MODEL_ORDER_FIELD,
  SHOW_USAGE_FIELD,
} from '../src/settings.js'

/** Resolve one field the way the Host's config schema does, defaults included. */
function resolve(field: keyof typeof SettingsFields, value: unknown): unknown {
  // The per-field schema narrows its own input; the helper keeps the table
  // readable by taking one widened value and letting the schema judge it.
  return (SettingsFields[field] as (input: unknown) => unknown)(value)
}

describe('SettingsFields defaults', () => {
  it('fills the declared defaults when a field is absent', () => {
    expect(resolve(SHOW_USAGE_FIELD, undefined)).toBe(DEFAULT_SHOW_USAGE)
    expect(resolve(CUSTOM_LIMIT_UNIT_FIELD, undefined)).toBe(DEFAULT_CREDIT_UNIT)
    expect(resolve(DANGER_PCT_FIELD, undefined)).toBe(DEFAULT_DANGER_PCT)
    expect(resolve(MODEL_ORDER_FIELD, undefined)).toEqual([])
    expect(resolve(HIDDEN_MODELS_FIELD, undefined)).toEqual([])
  })

  it('leaves the custom cap absent, so "follow the meter" stays expressible', () => {
    // No default on purpose: an absent cap is a distinct state from a zero cap.
    expect(resolve(CUSTOM_LIMIT_FIELD, undefined)).toBeUndefined()
    expect(resolve(CUSTOM_LIMIT_FIELD, 0)).toBe(0)
  })

  it('resolves a fresh array per call, since snapshots are handed to callers', () => {
    const first = resolve(MODEL_ORDER_FIELD, undefined) as string[]
    const second = resolve(MODEL_ORDER_FIELD, undefined) as string[]
    expect(first).not.toBe(second)
  })
})

describe('custom quota cap', () => {
  it('accepts the zero floor, which is a real budget of zero', () => {
    expect(resolve(CUSTOM_LIMIT_FIELD, CUSTOM_LIMIT_MIN)).toBe(0)
    expect(resolve(CUSTOM_LIMIT_FIELD, 1234.5)).toBe(1234.5)
  })

  it('refuses a negative cap at the write', () => {
    expect(() => resolve(CUSTOM_LIMIT_FIELD, -1)).toThrow(/>= 0/u)
  })

  it('refuses a non-numeric cap rather than coercing it', () => {
    expect(() => resolve(CUSTOM_LIMIT_FIELD, '10')).toThrow(/expected number/u)
  })

  it('passes non-finite numbers through, leaving the finite check to the client', () => {
    // The bound is a range, not a finiteness test: the client's `normalize`
    // drops a non-finite cap before it ever reaches a surface. Pinned here so
    // the two layers cannot silently swap responsibilities.
    expect(resolve(CUSTOM_LIMIT_FIELD, Number.NaN)).toBeNaN()
    expect(resolve(CUSTOM_LIMIT_FIELD, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('danger threshold', () => {
  it('accepts the whole declared range', () => {
    for (const value of [DANGER_PCT_MIN, 50, 90, DANGER_PCT_MAX]) {
      expect(resolve(DANGER_PCT_FIELD, value)).toBe(value)
    }
  })

  it('refuses values outside the range', () => {
    expect(() => resolve(DANGER_PCT_FIELD, DANGER_PCT_MIN - 1)).toThrow(/>= 1/u)
    expect(() => resolve(DANGER_PCT_FIELD, DANGER_PCT_MAX + 1)).toThrow(/<= 100/u)
  })

  it('refuses a fractional percentage, since the control steps by one', () => {
    expect(() => resolve(DANGER_PCT_FIELD, 90.5)).toThrow(/multiple of 1/u)
  })
})

describe('credit unit', () => {
  it('accepts every offered unit', () => {
    for (const unit of ['credit', 'cny', 'usd'] as const) {
      expect(resolve(CUSTOM_LIMIT_UNIT_FIELD, unit)).toBe(unit)
    }
  })

  it('refuses a unit the client cannot convert', () => {
    expect(() => resolve(CUSTOM_LIMIT_UNIT_FIELD, 'eur')).toThrow(/credit.*cny.*usd/u)
  })
})

describe('string list fields', () => {
  it('accepts id lists in order', () => {
    expect(resolve(MODEL_ORDER_FIELD, ['a', 'b'])).toEqual(['a', 'b'])
    expect(resolve(HIDDEN_MODELS_FIELD, ['x'])).toEqual(['x'])
    expect(resolve(MODEL_ORDER_FIELD, [])).toEqual([])
  })

  it('refuses a non-string entry rather than coercing it', () => {
    expect(() => resolve(MODEL_ORDER_FIELD, ['a', 2])).toThrow(/expected string/u)
    expect(() => resolve(HIDDEN_MODELS_FIELD, [5])).toThrow(/expected string/u)
  })

  it('refuses a non-array value', () => {
    expect(() => resolve(MODEL_ORDER_FIELD, 'a,b')).toThrow(/expected array/u)
  })

  it('passes a null entry through, leaving the filter to the client', () => {
    // `z.array(z.string())` tolerates a null member here, so the client's
    // `stringList` is what actually drops it. Pinned so that filter is not
    // removed as redundant.
    expect(resolve(HIDDEN_MODELS_FIELD, [null])).toEqual([null])
  })
})
