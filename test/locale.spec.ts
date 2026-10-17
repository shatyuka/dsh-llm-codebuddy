import { describe, expect, it } from 'vitest'
import { MessageLocale, prefersChinese, wordingKeys } from '../src/locale.js'

describe('prefersChinese', () => {
  it('reports English until a tag is reported', () => {
    expect(prefersChinese(undefined)).toBe(false)
  })

  it('accepts any Chinese tag, not just Simplified', () => {
    // CodeBuddy discloses exactly two wordings per field, so every `zh`
    // region reads the Chinese one.
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-HK', 'zh-MO', 'ZH-cn', ' zh ']) {
      expect(prefersChinese(tag), tag).toBe(true)
    }
  })

  it('rejects everything else', () => {
    for (const tag of ['en', 'en-US', 'ja', 'zhx', 'zh_CN', '']) {
      expect(prefersChinese(tag), tag).toBe(false)
    }
  })
})

describe('wordingKeys', () => {
  it('offers no key for an unreported or empty tag', () => {
    expect(wordingKeys(undefined)).toEqual([])
    expect(wordingKeys('')).toEqual([])
    expect(wordingKeys('   ')).toEqual([])
  })

  it('names the reported tag itself first', () => {
    // The reported id is always tried first, so a service that later ships a
    // regional variant gets to use it; any fallback follows.
    expect(wordingKeys('en')).toEqual(['en'])
    expect(wordingKeys('FR')).toEqual(['fr'])
    expect(wordingKeys('zh-CN')[0]).toBe('zh-cn')
  })

  it('adds the traditional-Chinese key for the three traditional regions', () => {
    // A language pack selects the Traditional wording by region, so those
    // ids must reach the one `zh-hant` key the service ships.
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO']) {
      expect(wordingKeys(tag)).toEqual([tag.toLowerCase(), 'zh-hant'])
    }
  })

  it('falls back a regional Simplified Chinese id to the plain `zh` key', () => {
    // The service ships `zh`, not `zh-cn`; without the fallback the lookup
    // misses and a Chinese reader gets the English wording instead.
    for (const tag of ['zh-CN', 'zh-Hans', 'zh-SG', 'zh-MY']) {
      expect(wordingKeys(tag), tag).toEqual([tag.toLowerCase(), 'zh'])
    }
  })

  it('lists the regional id before its fallback, so a shipped variant still wins', () => {
    // If the service ever adds `zh-cn`, the more specific wording is preferred
    // over the generic one; the fallback is only a safety net.
    expect(wordingKeys('zh-CN')).toEqual(['zh-cn', 'zh'])
    expect(wordingKeys('zh-TW')).toEqual(['zh-tw', 'zh-hant'])
  })

  it('never sends a Traditional region to the Simplified key', () => {
    // `zh` carries the simplified wording, so routing a traditional reader
    // there would answer them in the wrong script.
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO']) {
      expect(wordingKeys(tag), tag).not.toContain('zh')
    }
  })

  it('does not invent a Chinese fallback for a non-Chinese tag', () => {
    for (const tag of ['en', 'ja', 'fr-CA', 'en-US', 'zhx', 'zh_CN']) {
      expect(wordingKeys(tag), tag).toEqual([tag.toLowerCase()])
    }
  })

  it('agrees with prefersChinese about which tags carry Chinese', () => {
    // Both functions read the same reported tag, so every tag one calls
    // Chinese must reach a key the service actually ships.
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-HK', 'zh-MO']) {
      expect(prefersChinese(tag), tag).toBe(true)
      expect(wordingKeys(tag).some(key => key === 'zh' || key === 'zh-hant'), tag).toBe(true)
    }
  })
})

describe('MessageLocale', () => {
  it('starts with no tag', () => {
    expect(new MessageLocale().tag()).toBeUndefined()
  })

  it('remembers the last reported tag', () => {
    const locale = new MessageLocale()
    locale.report('zh-CN')
    expect(locale.tag()).toBe('zh-CN')
    locale.report('en-US')
    expect(locale.tag()).toBe('en-US')
  })

  it('clears the tag when the client reports nothing usable', () => {
    const locale = new MessageLocale()
    locale.report('zh')
    locale.report(undefined)
    expect(locale.tag()).toBeUndefined()
    locale.report('zh')
    // The tag arrives over the wire, so a non-string must not be stored as-is.
    locale.report(42)
    expect(locale.tag()).toBeUndefined()
    locale.report('')
    expect(locale.tag()).toBeUndefined()
  })
})
