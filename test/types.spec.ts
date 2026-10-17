import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cliModels,
  hasDisclosedCapacity,
  isPromotionActive,
  normalizeCredits,
} from '../src/types.js'
import type { CodeBuddyConfig, CodeBuddyModel, CodeBuddyModelPromotion } from '../src/types.js'

describe('normalizeCredits', () => {
  it('normalizes a bare rate to the `xN` form', () => {
    expect(normalizeCredits('3.5')).toBe('x3.5')
    expect(normalizeCredits('x0.34')).toBe('x0.34')
  })

  it('strips decoration the service occasionally ships', () => {
    // "x0.34 credits" must not reach the picker verbatim.
    expect(normalizeCredits('x0.34 credits')).toBe('x0.34')
    expect(normalizeCredits('rate: 1.25x')).toBe('x1.25')
  })

  it('keeps a zero rate rather than hiding it', () => {
    expect(normalizeCredits('x0.00')).toBe('x0.00')
    expect(normalizeCredits('0')).toBe('x0')
  })

  it('reports absence for an empty or numberless label', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('free')).toBeUndefined()
    expect(normalizeCredits('x')).toBeUndefined()
  })
})

describe('hasDisclosedCapacity', () => {
  const sized = (over: Partial<CodeBuddyModel>): CodeBuddyModel =>
    ({ id: 'm', name: 'M', maxAllowedSize: 1, maxOutputTokens: 1, ...over })

  it('requires both capacities to be present and positive', () => {
    expect(hasDisclosedCapacity(sized({}))).toBe(true)
    expect(hasDisclosedCapacity(sized({ maxAllowedSize: 0 }))).toBe(false)
    expect(hasDisclosedCapacity(sized({ maxOutputTokens: 0 }))).toBe(false)
    expect(hasDisclosedCapacity(sized({ maxOutputTokens: -1 }))).toBe(false)
  })

  it('rejects an entry with either capacity withheld', () => {
    // The key must be absent, not `undefined`: `exactOptionalPropertyTypes`
    // is what the catalog wire actually expresses.
    const { maxAllowedSize: _size, ...withoutSize } = sized({})
    const { maxOutputTokens: _output, ...withoutOutput } = sized({})
    expect(hasDisclosedCapacity(withoutSize)).toBe(false)
    expect(hasDisclosedCapacity(withoutOutput)).toBe(false)
  })

  it('rejects an entry with no capacity at all, as non-chat models are', () => {
    expect(hasDisclosedCapacity({ id: 'image', name: 'Image' })).toBe(false)
  })
})

describe('cliModels', () => {
  const catalog: CodeBuddyModel[] = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]

  it('returns the declared list in the agent order, not the catalog order', () => {
    const config: CodeBuddyConfig = { models: catalog, agents: [{ name: 'cli', models: ['c', 'a'] }] }
    expect([...cliModels(config)!.keys()]).toEqual(['c', 'a'])
  })

  it('prefers the craft agent over the cli agent', () => {
    const config: CodeBuddyConfig = {
      models: catalog,
      agents: [
        { name: 'cli', models: ['a'] },
        { name: 'craft', models: ['b'] },
      ],
    }
    expect([...cliModels(config)!.keys()]).toEqual(['b'])
  })

  it('falls back to the cli agent when craft names nothing', () => {
    const config: CodeBuddyConfig = {
      models: catalog,
      agents: [
        { name: 'craft', models: [] },
        { name: 'cli', models: ['a'] },
      ],
    }
    expect([...cliModels(config)!.keys()]).toEqual(['a'])
  })

  it('drops ids the catalog does not list, and keeps first occurrences', () => {
    const config: CodeBuddyConfig = { models: catalog, agents: [{ name: 'cli', models: ['b', 'ghost', 'b', 'a'] }] }
    expect([...cliModels(config)!.keys()]).toEqual(['b', 'a'])
  })

  it('returns undefined for a catalog with no declared agent list', () => {
    expect(cliModels({ models: catalog })).toBeUndefined()
    expect(cliModels({ models: catalog, agents: [] })).toBeUndefined()
    expect(cliModels({ models: catalog, agents: [{ name: 'cli', models: [] }] })).toBeUndefined()
    expect(cliModels({ models: catalog, agents: [{ name: 'other', models: ['a'] }] })).toBeUndefined()
  })
})

describe('isPromotionActive', () => {
  const promotion = (over: Partial<CodeBuddyModelPromotion>): CodeBuddyModelPromotion =>
    ({ id: 'p', ...over })

  beforeEach(() => {
    vi.useFakeTimers()
    // 2024-01-15T10:30:00Z — a Monday, comfortably inside business hours.
    vi.setSystemTime(new Date('2024-01-15T10:30:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never runs a disabled promotion', () => {
    expect(isPromotionActive(promotion({ enabled: false }))).toBe(false)
  })

  it('always runs one with no schedule', () => {
    expect(isPromotionActive(promotion({}))).toBe(true)
  })

  it('honours the absolute validity bounds', () => {
    expect(isPromotionActive(promotion({ schedule: { validFrom: '2024-02-01T00:00:00Z' } }))).toBe(false)
    expect(isPromotionActive(promotion({ schedule: { validUntil: '2024-01-01T00:00:00Z' } }))).toBe(false)
    expect(isPromotionActive(promotion({ schedule: {
      validFrom: '2024-01-01T00:00:00Z',
      validUntil: '2024-02-01T00:00:00Z',
    } }))).toBe(true)
  })

  it('treats the bounds as inclusive start and exclusive end', () => {
    expect(isPromotionActive(promotion({ schedule: { validFrom: '2024-01-15T10:30:00Z' } }))).toBe(true)
    expect(isPromotionActive(promotion({ schedule: { validUntil: '2024-01-15T10:30:00Z' } }))).toBe(false)
  })

  it('ignores an unparseable validity bound rather than disabling the promotion', () => {
    expect(isPromotionActive(promotion({ schedule: { validFrom: 'not a date' } }))).toBe(true)
    expect(isPromotionActive(promotion({ schedule: { validUntil: 'not a date' } }))).toBe(true)
  })

  it('honours a daily window in the schedule timezone', () => {
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '10:00', end: '11:00' }] },
    }))).toBe(true)
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '11:00', end: '12:00' }] },
    }))).toBe(false)
  })

  it('evaluates the window in the declared timezone, not the host clock', () => {
    // 10:30 UTC is 18:30 in Shanghai, which is outside a 10:00–11:00 window.
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '10:00', end: '11:00' }] },
    }))).toBe(false)
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '18:00', end: '19:00' }] },
    }))).toBe(true)
  })

  it('wraps a window whose end precedes its start past midnight', () => {
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '22:00', end: '02:00' }] },
    }))).toBe(false)
    vi.setSystemTime(new Date('2024-01-15T23:30:00Z'))
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '22:00', end: '02:00' }] },
    }))).toBe(true)
    vi.setSystemTime(new Date('2024-01-15T01:30:00Z'))
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '22:00', end: '02:00' }] },
    }))).toBe(true)
  })

  it('treats a zero-length window as covering the whole day', () => {
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '05:00', end: '05:00' }] },
    }))).toBe(true)
  })

  it('drops a window with a malformed edge', () => {
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: 'nope', end: '11:00' }] },
    }))).toBe(false)
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '10:00', end: '1x:00' }] },
    }))).toBe(false)
  })

  it('rejects a clock value outside a real day, rather than reading it as minutes', () => {
    // 24:00 and 25:00 parse as integers; only the range check keeps them from
    // becoming minute 1440/1500, which would silently widen the window.
    for (const [start, end] of [['24:00', '25:00'], ['10:00', '24:00'], ['-1:00', '11:00']] as const) {
      expect(isPromotionActive(promotion({
        schedule: { timezone: 'UTC', daily: [{ start, end }] },
      })), `${start}-${end}`).toBe(false)
    }
    // A minutes field above 59 is equally out of range.
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '10:60', end: '11:00' }] },
    }))).toBe(false)
  })

  it('passes when any one of several windows covers the moment', () => {
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'UTC', daily: [{ start: '01:00', end: '02:00' }, { start: '10:00', end: '11:00' }] },
    }))).toBe(true)
  })

  it('falls back to the host clock for an unknown timezone', () => {
    // `Intl` rejects the zone; the fallback must not throw, it just reads the
    // local clock, so the answer still reflects today's window on this host.
    const now = new Date()
    const hours = String(now.getHours()).padStart(2, '0')
    const ends = String((now.getHours() + 1) % 24).padStart(2, '0')
    expect(isPromotionActive(promotion({
      schedule: { timezone: 'Not/AZone', daily: [{ start: `${hours}:00`, end: `${ends}:00` }] },
    }))).toBe(true)
  })
})
