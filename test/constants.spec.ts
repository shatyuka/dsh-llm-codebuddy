import { describe, expect, it } from 'vitest'
import {
  CODEBUDDY_IDE_USER_AGENT,
  CODEBUDDY_SITES,
  DEFAULT_SITE_ID,
  WORKBUDDY_USER_AGENT,
  catalogUserAgentOf,
  endpointOf,
  isSiteId,
  resolveSite,
} from '../src/constants.js'

describe('site identity', () => {
  it('names both supported deployments by service root', () => {
    expect(CODEBUDDY_SITES).toEqual({
      cn: 'https://copilot.tencent.com',
      intl: 'https://www.codebuddy.ai',
    })
  })

  it('defaults to the China site', () => {
    expect(DEFAULT_SITE_ID).toBe('cn')
  })

  it('accepts only the known site ids', () => {
    expect(isSiteId('cn')).toBe(true)
    expect(isSiteId('intl')).toBe(true)
    expect(isSiteId('us')).toBe(false)
    expect(isSiteId('')).toBe(false)
    expect(isSiteId(undefined)).toBe(false)
    expect(isSiteId(null)).toBe(false)
    expect(isSiteId(0)).toBe(false)
  })

  it('does not mistake inherited object members for site ids', () => {
    // A site id read from disk or RPC could be any string; `Object.hasOwn`
    // is what keeps `constructor` from resolving as a deployment.
    expect(isSiteId('constructor')).toBe(false)
    expect(isSiteId('toString')).toBe(false)
  })

  it('resolves an unknown site to the default', () => {
    expect(resolveSite('intl')).toBe('intl')
    expect(resolveSite('nope')).toBe('cn')
    expect(resolveSite(undefined)).toBe('cn')
    expect(resolveSite({ site: 'intl' })).toBe('cn')
  })

  it('maps a site to an origin without a trailing slash', () => {
    expect(endpointOf('cn')).toBe('https://copilot.tencent.com')
    expect(endpointOf('intl')).toBe('https://www.codebuddy.ai')
    expect(endpointOf('cn').endsWith('/')).toBe(false)
  })
})

describe('catalogUserAgentOf', () => {
  it('keeps the IDE agent on the China site', () => {
    expect(catalogUserAgentOf('cn')).toBe(CODEBUDDY_IDE_USER_AGENT)
    expect(CODEBUDDY_IDE_USER_AGENT).toBe('CodeBuddyIDE/4.12.0')
  })

  it('uses the WorkBuddy CLI agent on the international site', () => {
    // `/v3/config` keys its listing per product name: only the CLI agent
    // receives the full international list.
    expect(catalogUserAgentOf('intl')).toBe(WORKBUDDY_USER_AGENT)
    expect(WORKBUDDY_USER_AGENT).toBe('WorkBuddy/5.7.2 CLI/2.156.0')
  })

  it('returns a user-agent that carries a version token', () => {
    for (const site of ['cn', 'intl'] as const) {
      expect(catalogUserAgentOf(site)).toMatch(/\d+\.\d+/)
    }
  })
})
