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
    expect(wordingKeys('en')).toEqual(['en'])
    expect(wordingKeys('zh-CN')).toEqual(['zh-cn'])
    expect(wordingKeys('FR')).toEqual(['fr'])
  })

  it('adds the traditional-Chinese key for the three traditional regions', () => {
    // A language pack selects the Traditional wording by region, so those
    // ids must reach the one `zh-hant` key the service ships.
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO']) {
      expect(wordingKeys(tag)).toEqual([tag.toLowerCase(), 'zh-hant'])
    }
  })

  it('does not route Simplified Chinese to the traditional key', () => {
    expect(wordingKeys('zh-CN')).toEqual(['zh-cn'])
    expect(wordingKeys('zh-Hans')).toEqual(['zh-hans'])
  })

  it('names a key CodeBuddy does not ship for a regional Simplified tag', () => {
    // Known gap, pinned deliberately rather than papered over: failure
    // envelopes ship only `en`, `zh`, and `zh-hant`, so a `zh-CN` client asks
    // for `zh-cn`, misses, and the English wording wins even though
    // `prefersChinese` reports Chinese for that same tag. `wordingKeys` is the
    // only key list a failure read consults, so this assertion documents the
    // current behaviour; changing it is a product decision, not a test fix.
    expect(prefersChinese('zh-CN')).toBe(true)
    expect(wordingKeys('zh-CN')).not.toContain('zh')
    expect(wordingKeys('zh')).toContain('zh')
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
