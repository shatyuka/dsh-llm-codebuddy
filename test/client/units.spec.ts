import { describe, expect, it } from 'vitest'
import {
  CNY_PER_USD,
  CREDITS_PER_CNY,
  CREDITS_PER_USD,
  creditsToUnit,
  formatDraft,
  formatInUnit,
  unitMinimum,
  unitToCredits,
} from '../../src/client/units.js'

describe('rate constants', () => {
  it('fixes 100 credits to the dollar and 7 yuan to the dollar', () => {
    expect(CREDITS_PER_USD).toBe(100)
    expect(CNY_PER_USD).toBe(7)
    expect(CREDITS_PER_CNY).toBeCloseTo(14.2857, 4)
  })
})

describe('creditsToUnit', () => {
  it('converts credits into dollars at 100 per dollar', () => {
    expect(creditsToUnit(100, 'usd')).toBe(1)
    expect(creditsToUnit(250, 'usd')).toBe(2.5)
    expect(creditsToUnit(0, 'usd')).toBe(0)
  })

  it('converts credits into yuan at 100/7 per yuan', () => {
    expect(creditsToUnit(100, 'cny')).toBeCloseTo(7, 10)
    expect(creditsToUnit(14.2857, 'cny')).toBeCloseTo(1, 4)
  })

  it('leaves credits untouched', () => {
    expect(creditsToUnit(1234.56, 'credit')).toBe(1234.56)
  })
})

describe('unitToCredits', () => {
  it('converts dollars and yuan back into credits', () => {
    expect(unitToCredits(1, 'usd')).toBe(100)
    expect(unitToCredits(1, 'cny')).toBeCloseTo(14.2857, 4)
    expect(unitToCredits(7, 'cny')).toBe(100)
  })

  it('leaves credits untouched', () => {
    expect(unitToCredits(14.28571, 'credit')).toBe(14.28571)
  })

  it('rounds away float noise so a stored cap is a clean figure', () => {
    // 0.1 + 0.2 dollars is 30.000000000000004 credits unrounded.
    expect(unitToCredits(0.1 + 0.2, 'usd')).toBe(30)
    expect(unitToCredits(3 * 0.1, 'usd')).toBe(30)
  })

  it('keeps four decimal places, the precision a yuan amount resolves to', () => {
    expect(unitToCredits(0.01, 'cny')).toBe(0.1429)
    expect(unitToCredits(1.005, 'usd')).toBe(100.5)
  })

  it('round-trips a whole-dollar amount exactly', () => {
    for (const credits of [100, 250, 1000]) {
      expect(unitToCredits(creditsToUnit(credits, 'usd'), 'usd')).toBe(credits)
    }
  })
})

describe('unitMinimum', () => {
  it('returns the credit floor unchanged for credits', () => {
    expect(unitMinimum('credit', 0)).toBe(0)
    expect(unitMinimum('credit', 10)).toBe(10)
  })

  it('expresses the floor in the currency, rounded to two decimals', () => {
    expect(unitMinimum('usd', 0)).toBe(0)
    expect(unitMinimum('usd', 50)).toBe(0.5)
    expect(unitMinimum('cny', 70)).toBe(4.9)
  })

  it('rounds a sub-cent credit floor to a sub-cent currency minimum', () => {
    expect(unitMinimum('usd', 10)).toBe(0.1)
  })
})

describe('formatInUnit', () => {
  it('shows credits at the meter\'s own display precision', () => {
    // Display rounds to one decimal; the stored figure is not touched.
    expect(formatInUnit(1234.56, 'credit')).toBe('1,234.6')
    expect(formatInUnit(0, 'credit')).toBe('0')
    expect(formatInUnit(3, 'credit')).toBe('3')
  })

  it('shows currencies with exactly two decimals', () => {
    expect(formatInUnit(1234, 'usd')).toBe('12.34')
    expect(formatInUnit(100, 'usd')).toBe('1.00')
    expect(formatInUnit(7, 'cny')).toBe('0.49')
  })

  it('does not append a unit label, which the caller adds', () => {
    expect(formatInUnit(100, 'usd')).not.toContain('$')
    expect(formatInUnit(100, 'cny')).not.toContain('¥')
  })
})

describe('formatDraft', () => {
  it('echoes a credit figure exactly as stored', () => {
    // The field is only written back when its text changed, so echoing the
    // exact figure is what keeps a blur from drifting the stored value.
    expect(formatDraft(14.28571, 'credit')).toBe('14.28571')
    expect(formatDraft(0, 'credit')).toBe('0')
  })

  it('trims a currency draft to at most two decimals', () => {
    expect(formatDraft(1.234, 'usd')).toBe('1.23')
    expect(formatDraft(2.5, 'cny')).toBe('2.5')
    expect(formatDraft(100, 'usd')).toBe('100')
  })

  it('rounds a halfway currency draft down, as binary floating point dictates', () => {
    // `1.005 * 100` is 100.49999999999999 in IEEE-754, so the half-up intent
    // reads as a round-down. Pinned so the behaviour is a documented property
    // of the rounding rather than an unexplained surprise at a blur.
    expect(1.005 * 100).toBeLessThan(100.5)
    expect(formatDraft(1.005, 'usd')).toBe('1')
  })
})
