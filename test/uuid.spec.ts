import { describe, expect, it, vi, afterEach } from 'vitest'
import { uuidv7 } from '../src/uuid.js'

describe('uuidv7', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes 32 lowercase hex digits with no separator', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('marks version 7 and the RFC variant', () => {
    const id = uuidv7()
    // The 13th hex digit is the version nibble, the 17th the variant nibble.
    expect(id[12]).toBe('7')
    expect(['8', '9', 'a', 'b']).toContain(id[16])
  })

  it('leads with the creation time in milliseconds', () => {
    vi.useFakeTimers()
    const when = new Date('2026-01-02T03:04:05.006Z')
    vi.setSystemTime(when)
    expect(parseInt(uuidv7().slice(0, 12), 16)).toBe(when.getTime())
  })

  it('sorts as text in creation order', () => {
    vi.useFakeTimers()
    const ids: string[] = []
    for (const ms of [1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002]) {
      vi.setSystemTime(ms)
      ids.push(uuidv7())
    }
    expect([...ids].sort()).toEqual(ids)
  })

  it('differs on every call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7()))
    expect(ids.size).toBe(100)
  })

  it('refuses a time the timestamp field cannot hold', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2 ** 48)
    expect(() => uuidv7()).toThrow(RangeError)
  })
})
