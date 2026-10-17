import { describe, expect, it } from 'vitest'
import {
  badgesOf,
  creditsOf,
  isFreeCredits,
  parseTag,
  rowRate,
} from '../../src/client/model-badges.js'
import type { CodeBuddyModelEntry, CodeBuddyPromotionView } from '../../src/protocol.js'

describe('parseTag', () => {
  it('parses the enterprise badge form', () => {
    expect(parseTag('badge:Fast:#A1B2C3')).toEqual({ label: 'Fast', color: '#A1B2C3' })
  })

  it('accepts lowercase and mixed-case hex, normalized to a leading #', () => {
    expect(parseTag('badge:New:#abcdef')).toEqual({ label: 'New', color: '#abcdef' })
    expect(parseTag('badge:New:#AbCdEf')).toEqual({ label: 'New', color: '#AbCdEf' })
  })

  it('drops a tag whose color is not six hex digits', () => {
    for (const tag of ['badge:Fast:#GGGGGG', 'badge:Fast:#fff', 'badge:Fast:fff', 'badge:Fast:#1234567']) {
      expect(parseTag(tag), tag).toBeUndefined()
    }
  })

  it('drops the opaque craft tag and any non-badge tag', () => {
    expect(parseTag('craft')).toBeUndefined()
    expect(parseTag('')).toBeUndefined()
    expect(parseTag('badge:')).toBeUndefined()
  })

  it('requires a non-empty label', () => {
    expect(parseTag('badge::#000000')).toBeUndefined()
  })

  it('accepts a label with spaces and punctuation', () => {
    expect(parseTag('badge:Best value!:#00AA00')).toEqual({ label: 'Best value!', color: '#00AA00' })
  })

  it('accepts a label that itself contains a colon, keeping the last one as the separator', () => {
    // The label group is greedy, so the color separator is the final `:#`.
    expect(parseTag('badge:Rate:x2:#00AA00')).toEqual({ label: 'Rate:x2', color: '#00AA00' })
  })

  it('rejects a tag missing the separator colon before the color', () => {
    expect(parseTag('badge:Best value!#00AA00')).toBeUndefined()
  })
})

describe('badgesOf', () => {
  it('keeps only the displayable pills, in catalog order', () => {
    expect(badgesOf(['badge:A:#111111', 'craft', 'badge:B:#222222'])).toEqual([
      { label: 'A', color: '#111111', key: 'tag:0' },
      { label: 'B', color: '#222222', key: 'tag:2' },
    ])
  })

  it('keys a pill by its position, so repeated labels do not collide', () => {
    // React list keys must be unique; two badges can legitimately share a label.
    const pills = badgesOf(['badge:Sale:#111111', 'badge:Sale:#222222'])
    expect(pills.map(pill => pill.key)).toEqual(['tag:0', 'tag:1'])
    expect(new Set(pills.map(pill => pill.key)).size).toBe(2)
  })

  it('returns an empty list for absent or empty tags', () => {
    expect(badgesOf(undefined)).toEqual([])
    expect(badgesOf([])).toEqual([])
    expect(badgesOf(['craft'])).toEqual([])
  })
})

describe('creditsOf', () => {
  it('reads the rate from the enriched entry', () => {
    const entry: CodeBuddyModelEntry = { id: 'm', name: 'M', credits: 'x1.50' }
    expect(creditsOf(entry)).toBe('x1.50')
  })

  it('reports absence for a missing entry or a missing rate', () => {
    expect(creditsOf(undefined)).toBeUndefined()
    expect(creditsOf({ id: 'm', name: 'M' })).toBeUndefined()
  })
})

describe('rowRate', () => {
  it('shows the catalog rate when no promotion runs', () => {
    expect(rowRate('x1.00', undefined)).toEqual({ label: 'x1.00', promo: false, free: false })
  })

  it('reports nothing when neither a rate nor a promotion exists', () => {
    expect(rowRate(undefined, undefined)).toBeUndefined()
  })

  it('replaces the catalog rate with an active promotion override, tinted', () => {
    const promotion: CodeBuddyPromotionView = { color: '#ff0000', label: 'Sale', discountedRate: 'x0.5' }
    expect(rowRate('x1.00', promotion)).toEqual({
      label: 'x0.5',
      promo: true,
      free: false,
      tint: '#ff0000',
    })
  })

  it('shows a promotion rate even when the catalog disclosed none', () => {
    const promotion: CodeBuddyPromotionView = { color: '#ff0000', label: 'Sale', discountedRate: 'x0.5' }
    expect(rowRate(undefined, promotion)).toMatchObject({ label: 'x0.5', promo: true })
  })

  it('ignores a promotion that carries no rate override', () => {
    // The badge still renders elsewhere; only the row's trailing rate is here.
    const promotion: CodeBuddyPromotionView = { color: '#ff0000', label: 'Sale' }
    expect(rowRate('x2.00', promotion)).toEqual({ label: 'x2.00', promo: false, free: false })
  })

  it('flags a zero rate so the row can render it as free', () => {
    expect(rowRate('x0.00', undefined)).toEqual({ label: 'x0.00', promo: false, free: true })
    expect(rowRate('x0', undefined)).toMatchObject({ free: true })
  })

  it('floats the free flag to the effective label, not the catalog one', () => {
    const promotion: CodeBuddyPromotionView = { color: '#ff0000', label: 'Free week', discountedRate: 'x0.00' }
    expect(rowRate('x9.99', promotion)).toMatchObject({ label: 'x0.00', promo: true, free: true })
  })

  it('does not tint a label that came from the catalog', () => {
    const promotion: CodeBuddyPromotionView = { color: '#ff0000', label: 'Sale' }
    expect(rowRate('x1.00', promotion)).not.toHaveProperty('tint')
  })
})

describe('isFreeCredits', () => {
  it('recognizes the zero-rate spellings', () => {
    for (const label of ['x0', 'x0.0', 'x0.00', 'x0.000', ' X0.00 ']) {
      expect(isFreeCredits(label), label).toBe(true)
    }
  })

  it('rejects a non-zero rate', () => {
    for (const label of ['x0.5', 'x1', 'x10.00', '0', 'free']) {
      expect(isFreeCredits(label), label).toBe(false)
    }
  })

  it('reports false for an absent label', () => {
    expect(isFreeCredits(undefined)).toBe(false)
  })
})
