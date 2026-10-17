import { describe, expect, it } from 'vitest'
import { usedPercent } from '../src/quota.js'

describe('usedPercent', () => {
  it('reports the plain ratio as a percentage', () => {
    expect(usedPercent(0, 100)).toBe(0)
    expect(usedPercent(25, 100)).toBe(25)
    expect(usedPercent(50, 200)).toBe(25)
    expect(usedPercent(100, 100)).toBe(100)
  })

  it('keeps fractional percentages rather than rounding them', () => {
    expect(usedPercent(1, 3)).toBeCloseTo(33.333, 3)
    expect(usedPercent(3, 7)).toBeCloseTo(42.857, 3)
  })

  it('clamps to the [0, 100] range', () => {
    // An overspent window (a granted credit reported after the cap closed)
    // must read as full, never above 100.
    expect(usedPercent(150, 100)).toBe(100)
    expect(usedPercent(-10, 100)).toBe(0)
  })

  it('treats a zero limit as a real, fully-spent budget', () => {
    // The distinction the metric exists for: "0 of 0" is not "unknown",
    // it is a budget with no headroom at all.
    expect(usedPercent(0, 0)).toBe(100)
    expect(usedPercent(5, 0)).toBe(100)
  })

  it('treats a negative limit as no headroom', () => {
    expect(usedPercent(0, -1)).toBe(100)
  })
})
