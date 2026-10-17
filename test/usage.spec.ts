import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchEnterpriseUsage,
  fetchPersonalUsage,
  fetchUsage,
  parseUsage,
} from '../src/usage.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'

const identity: CodeBuddyIdentity = {
  accessToken: 'tok-123',
  domain: 'corp.example',
  uid: 'user-9',
  site: 'cn',
}

/** A personal reply in the shape the real plane nests it under. */
function personalBody(accounts: unknown[]): unknown {
  return { code: 0, msg: '', data: { Response: { Data: { Accounts: accounts } } } }
}

describe('parseUsage — personal account', () => {
  it('reads one window per package, deriving used from limit minus remaining', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'base', CycleCapacitySizePrecise: '1000', CycleCapacityRemainPrecise: '250' },
    ]))
    expect(snapshot?.windows).toEqual([
      { name: 'base', used: 750, limit: 1000, usedPercent: 75 },
    ])
  })

  it('accepts the figures as numbers as well as numeric strings', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'base', CycleCapacitySizePrecise: 1000, CycleCapacityRemainPrecise: 250 },
    ]))
    expect(snapshot?.windows[0]).toMatchObject({ used: 750, limit: 1000, usedPercent: 75 })
  })

  it('prefers the package code as the window name, then the resource id', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'base', CycleCapacitySizePrecise: 1 },
      { ResourceId: 'res-7', CycleCapacitySizePrecise: 1 },
      { CycleCapacitySizePrecise: 1 },
    ]))
    expect(snapshot?.windows.map(window => window.name)).toEqual(['base', 'res-7', 'resource_2'])
  })

  it('clamps a negative disclosed capacity to a zero budget', () => {
    // A negative size is not a real allowance; left unclamped it would render
    // a negative total and a nonsensical percentage.
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'p', CycleCapacitySizePrecise: -5, CycleCapacityRemainPrecise: '0' },
    ]))
    expect(snapshot?.windows[0]).toEqual({ name: 'p', used: 0, limit: 0, usedPercent: 100 })
    expect(snapshot?.primary).toMatchObject({ used: 0, limit: 0, usedPercent: 100 })
  })

  it('clamps a remaining figure above the cap to zero used', () => {
    // A granted top-up can leave remaining > size for one billing tick.
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'p', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 150 },
    ]))
    expect(snapshot?.windows[0]).toMatchObject({ used: 0, limit: 100, usedPercent: 0 })
  })

  it('keeps a disclosed zero as a real zero budget', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'p', CycleCapacitySizePrecise: '0', CycleCapacityRemainPrecise: '0' },
    ]))
    expect(snapshot?.windows[0]).toEqual({ name: 'p', used: 0, limit: 0, usedPercent: 100 })
  })

  it('contributes only a name when no capacity is disclosed', () => {
    // Undisclosed capacity is not zero capacity: drawing "0 of 0" would claim
    // the account is out of quota when the plane simply said nothing.
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'uncapped', CycleCapacityRemainPrecise: '12' },
    ]))
    expect(snapshot?.windows[0]).toEqual({ name: 'uncapped' })
    expect(snapshot?.windows[0]?.used).toBeUndefined()
    expect(snapshot?.windows[0]?.limit).toBeUndefined()
  })

  it('treats a blank or unparseable figure as undisclosed', () => {
    for (const value of ['', '   ', 'n/a', null, {}, []]) {
      const snapshot = parseUsage(personalBody([{ PackageCode: 'p', CycleCapacitySizePrecise: value }]))
      expect(snapshot?.windows[0]?.limit, JSON.stringify(value)).toBeUndefined()
    }
  })

  it('drops a remaining figure that is not a number to zero left', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'p', CycleCapacitySizePrecise: '100', CycleCapacityRemainPrecise: 'oops' },
    ]))
    expect(snapshot?.windows[0]).toMatchObject({ used: 100, limit: 100, usedPercent: 100 })
  })

  it('normalizes a cycle end of 23:59:59 into the following midnight', () => {
    // The quota resets at the next day's 00:00:00, not one second earlier.
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'p', CycleCapacitySizePrecise: 10, CycleEndTime: '2024-03-31 23:59:59' },
    ]))
    expect(snapshot?.windows[0]?.resetsAt).toBe('2024-04-01 00:00:00')
  })

  it('leaves any other reset timestamp as given', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'p', CycleCapacitySizePrecise: 10, CycleEndTime: '2024-03-31 18:00:00' },
    ]))
    expect(snapshot?.windows[0]?.resetsAt).toBe('2024-03-31 18:00:00')
  })
})

describe('parseUsage — aggregated primary window', () => {
  it('sums every metered package rather than showing the first', () => {
    // A personal account draws down a base package plus granted ones, and the
    // first listed package is arbitrary; showing it alone reads 100% once the
    // base empties even though the grants still pay for requests.
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'base', CycleCapacitySizePrecise: '1000', CycleCapacityRemainPrecise: '0' },
      { PackageCode: 'grant', CycleCapacitySizePrecise: '500', CycleCapacityRemainPrecise: '500' },
    ]))
    expect(snapshot?.primary).toMatchObject({ name: 'total', used: 1000, limit: 1500 })
    expect(snapshot?.primary?.usedPercent).toBeCloseTo(66.667, 3)
    expect(snapshot?.windows).toHaveLength(2)
  })

  it('excludes a package that disclosed no capacity from the totals', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'metered', CycleCapacitySizePrecise: '100', CycleCapacityRemainPrecise: '40' },
      { PackageCode: 'unknown' },
    ]))
    expect(snapshot?.primary).toMatchObject({ used: 60, limit: 100 })
  })

  it('reports the earliest reset among the packages that still hold credits', () => {
    // A spent base package resetting tomorrow must not mask the grant that
    // expires in a month.
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'spent', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 0, CycleEndTime: '2024-04-01 23:59:59' },
      { PackageCode: 'grant', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 100, CycleEndTime: '2024-06-01 23:59:59' },
    ]))
    expect(snapshot?.primary?.resetsAt).toBe('2024-06-02 00:00:00')
  })

  it('falls back to the earliest reset overall once every package is spent', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'a', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 0, CycleEndTime: '2024-04-01 23:59:59' },
      { PackageCode: 'b', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 0, CycleEndTime: '2024-06-01 23:59:59' },
    ]))
    expect(snapshot?.primary?.resetsAt).toBe('2024-04-02 00:00:00')
  })

  it('omits the reset when no package disclosed one', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'a', CycleCapacitySizePrecise: 100, CycleCapacityRemainPrecise: 50 },
    ]))
    expect(snapshot?.primary).toBeDefined()
    expect(snapshot?.primary && 'resetsAt' in snapshot.primary).toBe(false)
  })

  it('shows a fully spent account as 100%', () => {
    const snapshot = parseUsage(personalBody([
      { PackageCode: 'a', CycleCapacitySizePrecise: '0', CycleCapacityRemainPrecise: '0' },
    ]))
    expect(snapshot?.primary?.usedPercent).toBe(100)
  })

  it('exposes the only window as the primary when nothing is metered', () => {
    const snapshot = parseUsage(personalBody([{ PackageCode: 'only' }]))
    expect(snapshot?.primary).toEqual({ name: 'only' })
    expect(snapshot?.windows).toHaveLength(1)
  })

  it('returns an empty window list for a reply with no accounts at all', () => {
    const snapshot = parseUsage(personalBody([]))
    expect(snapshot).toEqual({ windows: [] })
  })
})

describe('parseUsage — pointer roots', () => {
  it('finds the accounts array under either gateway nesting', () => {
    const accounts = [{ PackageCode: 'p', CycleCapacitySizePrecise: 10, CycleCapacityRemainPrecise: 5 }]
    const roots = [
      { data: { Response: { Data: { Accounts: accounts } } } },
      { data: { data: { Response: { Data: { Accounts: accounts } } } } },
      { Response: { Data: { Accounts: accounts } } },
    ]
    for (const body of roots) {
      expect(parseUsage(body)?.windows[0]?.name, JSON.stringify(body).slice(0, 40)).toBe('p')
    }
  })

  it('reads an explicitly null accounts array as "nothing reported"', () => {
    expect(parseUsage({ data: { Response: { Data: { Accounts: null } } } })).toEqual({ windows: [] })
  })
})

describe('parseUsage — enterprise account', () => {
  it('reads the single limit/credit pair into one window', () => {
    const snapshot = parseUsage({ code: 0, data: { data: { limitNum: 100, credit: 25, cycleResetTime: '2024-02-01 00:00:00' } } })
    expect(snapshot).toEqual({
      windows: [{ name: 'enterprise', used: 25, limit: 100, usedPercent: 25, resetsAt: '2024-02-01 00:00:00' }],
      primary: { name: 'enterprise', used: 25, limit: 100, usedPercent: 25, resetsAt: '2024-02-01 00:00:00' },
    })
  })

  it('reads the figures from the root when the gateway does not wrap them', () => {
    expect(parseUsage({ limitNum: 50, credit: 10 })?.primary).toMatchObject({ used: 10, limit: 50 })
  })

  it('defaults an undisclosed `credit` to zero used', () => {
    expect(parseUsage({ limitNum: 50 })?.primary).toMatchObject({ used: 0, usedPercent: 0 })
  })

  it('clamps a negative disclosed limit to zero', () => {
    const snapshot = parseUsage({ limitNum: -5, credit: 0 })
    expect(snapshot?.primary).toMatchObject({ limit: 0, usedPercent: 100 })
  })

  it('reports nothing when no limit was disclosed', () => {
    expect(parseUsage({ credit: 10 })).toBeUndefined()
  })

  it('prefers a personal parse when the reply actually answered that shape', () => {
    // The account kind decides the request path, but the reply decides the
    // shape: a personal account carrying an enterpriseId must still parse.
    const snapshot = parseUsage({
      data: {
        Response: { Data: { Accounts: [{ PackageCode: 'personal', CycleCapacitySizePrecise: 10, CycleCapacityRemainPrecise: 10 }] } },
        data: { limitNum: 999, credit: 999 },
      },
    })
    expect(snapshot?.windows[0]?.name).toBe('personal')
  })

  it('returns nothing for a body that carries neither shape', () => {
    for (const body of [{}, null, '#$%', 42, []]) {
      expect(parseUsage(body), JSON.stringify(body)).toBeUndefined()
    }
  })
})

describe('fetchPersonalUsage', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts to the identity site with the authenticated headers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { Response: { Data: { Accounts: [] } } } }), { status: 200 }))
    await fetchPersonalUsage({ ...identity, enterpriseId: 'ent-1', departmentFullName: 'R&D/Platform' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/v2/billing/meter/get-user-resource')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer tok-123',
      'X-Domain': 'corp.example',
      'X-User-Id': 'user-9',
      // The meter plane expects the tenant id under both names.
      'X-Enterprise-Id': 'ent-1',
      'X-Tenant-Id': 'ent-1',
      'X-Department-Info': 'R&D/Platform',
      'User-Agent': 'CodeBuddyIDE/4.12.0',
    })
  })

  it('omits the tenant headers for a personal account', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { Response: { Data: { Accounts: [] } } } }), { status: 200 }))
    await fetchPersonalUsage(identity)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-Tenant-Id']).toBeUndefined()
    expect(headers['X-Department-Info']).toBeUndefined()
  })

  it('scopes the request to a same-day slice in the service timestamp format', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { Response: { Data: { Accounts: [] } } } }), { status: 200 }))
    await fetchPersonalUsage(identity)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>

    expect(body).toMatchObject({ PageNumber: 1, PageSize: 200, ProductCode: 'p_tcaca', Status: [0, 3] })
    const pattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
    expect(String(body['SlicePeriodStartTime'])).toMatch(pattern)
    expect(String(body['SlicePeriodEndTime'])).toMatch(pattern)
    // Both bounds must share the day the request was made.
    expect(String(body['SlicePeriodStartTime']).slice(0, 10)).toBe(String(body['SlicePeriodEndTime']).slice(0, 10))
    expect(String(body['SlicePeriodStartTime']).endsWith('00:00:00')).toBe(true)
    expect(String(body['SlicePeriodEndTime']).endsWith('23:59:59')).toBe(true)
  })

  it('uses the international host for an international credential', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await fetchPersonalUsage({ ...identity, site: 'intl' })
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://www.codebuddy.ai/v2/billing/meter/get-user-resource')
  })

  it('resolves undefined rather than throwing when the transport fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(fetchPersonalUsage(identity)).resolves.toBeUndefined()
  })

  it('resolves undefined on a non-2xx status', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }))
    await expect(fetchPersonalUsage(identity)).resolves.toBeUndefined()
  })

  it('resolves undefined on an unparseable body', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(fetchPersonalUsage(identity)).resolves.toBeUndefined()
  })

  it('treats a non-zero envelope code as a refused read', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 14018, msg: 'no quota' }), { status: 200 }))
    await expect(fetchPersonalUsage(identity)).resolves.toBeUndefined()
  })

  it('parses a successful reply end to end', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { Response: { Data: { Accounts: [
        { PackageCode: 'base', CycleCapacitySizePrecise: '200', CycleCapacityRemainPrecise: '50' },
      ] } } },
    }), { status: 200 }))
    const snapshot = await fetchPersonalUsage(identity)
    expect(snapshot?.primary).toMatchObject({ used: 150, limit: 200, usedPercent: 75 })
  })
})

describe('fetchEnterpriseUsage', () => {
  it('posts an empty object to the enterprise meter path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { data: { limitNum: 10, credit: 5 } } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const snapshot = await fetchEnterpriseUsage({ ...identity, enterpriseId: 'ent-1' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/v2/billing/meter/get-enterprise-user-usage')
    expect(init.body).toBe('{}')
    expect(snapshot?.primary).toMatchObject({ name: 'enterprise', used: 5, limit: 10 })
    vi.unstubAllGlobals()
  })
})

describe('fetchUsage', () => {
  it('reads the enterprise plane when the identity disclosed a tenant', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchUsage({ ...identity, enterpriseId: 'ent-1' })
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toContain('get-enterprise-user-usage')
    vi.unstubAllGlobals()
  })

  it('reads the personal plane otherwise', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchUsage(identity)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toContain('get-user-resource')
    vi.unstubAllGlobals()
  })
})
