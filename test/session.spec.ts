import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session owns no transport of its own: it composes the credential store,
// the control-plane client, and the usage meter. Mocking those three is what
// lets the tests drive expiry, refresh, and catalog timing deterministically.
vi.mock('../src/storage.js', () => ({
  loadStorage: vi.fn(),
  saveStorage: vi.fn(),
}))

vi.mock('../src/codebuddy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codebuddy.js')>()
  return {
    ...actual,
    getConfig: vi.fn(),
    refreshAccessToken: vi.fn(),
  }
})

vi.mock('../src/usage.js', () => ({ fetchUsage: vi.fn() }))

import { CodeBuddySession, NotLoggedInError, SessionUnavailableError } from '../src/session.js'
import { loadStorage, saveStorage } from '../src/storage.js'
import { ConfigRequestError, getConfig, refreshAccessToken } from '../src/codebuddy.js'
import { fetchUsage } from '../src/usage.js'
import type { CodeBuddyStorage } from '../src/storage.js'
import type { CodeBuddyModel } from '../src/types.js'

const load = vi.mocked(loadStorage)
const save = vi.mocked(saveStorage)
const config = vi.mocked(getConfig)
const refresh = vi.mocked(refreshAccessToken)
const usage = vi.mocked(fetchUsage)

/** A stored credential whose token is fresh unless the test says otherwise. */
function stored(over: {
  accessExpiresAt?: number
  refreshExpiresAt?: number
  account?: Partial<CodeBuddyStorage['account']>
} = {}): CodeBuddyStorage {
  return {
    site: 'cn',
    auth: {
      accessToken: 'access-1',
      expiresAt: over.accessExpiresAt ?? Date.now() + 3_600_000,
      refreshToken: 'refresh-1',
      refreshExpiresAt: over.refreshExpiresAt ?? Date.now() + 7_200_000,
      domain: 'corp.example',
    },
    account: { uid: 'uid-1', nickname: 'Nick', ...over.account },
  }
}

/** Newly issued tokens, as the refresh endpoint returns them. */
function refreshedToken(over: { accessToken?: string, expiresIn?: number, domain?: string } = {}) {
  return {
    accessToken: over.accessToken ?? 'access-2',
    expiresIn: over.expiresIn ?? 3_600,
    refreshToken: 'refresh-2',
    refreshExpiresIn: 7_200,
    domain: over.domain ?? 'corp.example',
  }
}

/** One catalog entry the adapter would offer. */
function model(id: string, over: Partial<CodeBuddyModel> = {}): CodeBuddyModel {
  return { id, name: id.toUpperCase(), maxAllowedSize: 100_000, maxOutputTokens: 4_000, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  // A signed-out default: every test that needs a credential says so, and a
  // `mockReturnValueOnce` override still wins for one call.
  load.mockResolvedValue(undefined)
  save.mockResolvedValue()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('signed-out session', () => {
  it('reports the sign-in remedy from a required identity', async () => {
    load.mockResolvedValue(undefined)
    const session = new CodeBuddySession()
    await expect(session.identity()).rejects.toBeInstanceOf(NotLoggedInError)
    await expect(session.identity()).rejects.toThrow(/Settings page/u)
  })

  it('reports not-logged-in without throwing on the advisory reads', async () => {
    load.mockResolvedValue(undefined)
    const session = new CodeBuddySession()
    await expect(session.isLoggedIn()).resolves.toBe(false)
    await expect(session.nickname()).resolves.toBeUndefined()
    await expect(session.isUsable()).resolves.toBe(false)
    await expect(session.modelsOrEmpty()).resolves.toEqual([])
    await expect(session.usage()).resolves.toBeUndefined()
  })

  it('does not consult the meter when nothing is signed in', async () => {
    load.mockResolvedValue(undefined)
    await new CodeBuddySession().usage()
    expect(usage).not.toHaveBeenCalled()
  })
})

describe('signed-in identity', () => {
  it('builds the identity from the stored credential', async () => {
    load.mockResolvedValue(stored({ account: { enterpriseId: 'ent-1', departmentFullName: 'R&D' } }))
    await expect(new CodeBuddySession().identity()).resolves.toEqual({
      accessToken: 'access-1',
      domain: 'corp.example',
      uid: 'uid-1',
      site: 'cn',
      enterpriseId: 'ent-1',
      departmentFullName: 'R&D',
    })
  })

  it('omits the tenant fields a personal account does not disclose', async () => {
    load.mockResolvedValue(stored())
    const identity = await new CodeBuddySession().identity()
    expect(identity).not.toHaveProperty('enterpriseId')
    expect(identity).not.toHaveProperty('departmentFullName')
  })

  it('reports the nickname from the store', async () => {
    load.mockResolvedValue(stored())
    await expect(new CodeBuddySession().nickname()).resolves.toBe('Nick')
  })

  it('shares one disk read between concurrent callers', async () => {
    load.mockResolvedValue(stored())
    const session = new CodeBuddySession()
    await Promise.all([session.isLoggedIn(), session.isLoggedIn(), session.identity()])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('re-reads from disk after an invalidation, so a login reaches a running harness', async () => {
    load.mockResolvedValue(stored())
    const session = new CodeBuddySession()
    await session.identity()
    session.invalidate()
    await session.identity()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('builds the headers every authenticated request carries', async () => {
    load.mockResolvedValue(stored({ account: { enterpriseId: 'ent-1' } }))
    const session = new CodeBuddySession()
    await expect(session.authHeaders()).resolves.toEqual({
      'Authorization': 'Bearer access-1',
      'X-Domain': 'corp.example',
      'X-User-Id': 'uid-1',
      'X-Enterprise-Id': 'ent-1',
    })
  })

  it('builds headers for an identity the caller already resolved', async () => {
    // The chat path resolves once and passes it in, so a concurrent login
    // cannot pair one site's identity with another's token.
    load.mockResolvedValue(stored())
    const session = new CodeBuddySession()
    await expect(session.authHeaders({
      accessToken: 'explicit',
      domain: 'other',
      uid: 'uid-9',
      site: 'intl',
    })).resolves.toEqual({
      'Authorization': 'Bearer explicit',
      'X-Domain': 'other',
      'X-User-Id': 'uid-9',
    })
    expect(load).not.toHaveBeenCalled()
  })
})

describe('token refresh', () => {
  it('refreshes a token at or near expiry and persists the new one', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: true, token: refreshedToken() })

    const identity = await new CodeBuddySession().identity()
    expect(identity.accessToken).toBe('access-2')
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-1', uid: 'uid-1' }),
      'refresh-1',
    )
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
    }))
  })

  it('refreshes inside the pre-expiry skew rather than waiting for the exact expiry', async () => {
    // 30s left is inside the 60s skew: refreshing now avoids a request that
    // expires in flight.
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() + 30_000 }))
    refresh.mockResolvedValue({ ok: true, token: refreshedToken() })
    await expect(new CodeBuddySession().identity()).resolves.toMatchObject({ accessToken: 'access-2' })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh a token outside the skew', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() + 120_000 }))
    await expect(new CodeBuddySession().identity()).resolves.toMatchObject({ accessToken: 'access-1' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('single-flights a refresh across concurrent callers', async () => {
    // Without coalescing, a burst of calls would each spend the rotating
    // refresh token and all but one would be replaying a spent one.
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return { ok: true, token: refreshedToken() }
    })

    const session = new CodeBuddySession()
    const identities = await Promise.all([session.identity(), session.identity(), session.identity()])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(identities.map(identity => identity.accessToken)).toEqual(['access-2', 'access-2', 'access-2'])
  })

  it('clears the single-flight slot once a refresh settles, so a later attempt can run', async () => {
    // The slot is cleared in a `finally`: a settled (or failed) attempt must
    // not wedge every later call onto one dead promise. The mocked disk still
    // holds the expired token after `invalidate()`, so the second call legitimately
    // spends the refresh a second time.
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: true, token: refreshedToken() })
    const session = new CodeBuddySession()
    await expect(session.identity()).resolves.toMatchObject({ accessToken: 'access-2' })
    session.invalidate()
    await expect(session.identity()).resolves.toMatchObject({ accessToken: 'access-2' })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('clears the single-flight slot after a failed refresh, so a retry is possible', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValueOnce({ ok: false, reason: 'unreachable' })
    const session = new CodeBuddySession()
    await expect(session.identity()).rejects.toBeInstanceOf(SessionUnavailableError)

    // A service that comes back must be reachable on the next attempt rather
    // than being shadowed by the rejected promise from the first.
    refresh.mockResolvedValueOnce({ ok: true, token: refreshedToken() })
    await expect(session.identity()).resolves.toMatchObject({ accessToken: 'access-2' })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('reports a refused refresh as a terminal sign-in failure', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: false, reason: 'rejected' })
    const session = new CodeBuddySession()
    await expect(session.identity()).rejects.toBeInstanceOf(NotLoggedInError)
    await expect(session.isUsable()).resolves.toBe(false)
  })

  it('reports an unreachable service as "maybe still valid", not as a sign-out', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: false, reason: 'unreachable' })
    const session = new CodeBuddySession()
    await expect(session.identity()).rejects.toBeInstanceOf(SessionUnavailableError)
    await expect(session.identity()).rejects.toThrow(/retry/u)
    // The credential was never judged, so the surface must not claim it expired.
    await expect(session.isUsable()).resolves.toBe(true)
  })

  it('requires a new browser login once the refresh token itself expired', async () => {
    load.mockResolvedValue(stored({
      accessExpiresAt: Date.now() - 1_000,
      refreshExpiresAt: Date.now() - 1_000,
    }))
    const session = new CodeBuddySession()
    await expect(session.identity()).rejects.toBeInstanceOf(NotLoggedInError)
    await expect(session.identity()).rejects.toThrow(/expired/u)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps the refreshed token in memory when it cannot be persisted', async () => {
    // A storage problem must not turn into an outage for this process.
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: true, token: refreshedToken() })
    save.mockRejectedValue(new Error('disk full'))
    const warn = vi.fn()
    const session = new CodeBuddySession({ warn, error: vi.fn() })

    await expect(session.identity()).resolves.toMatchObject({ accessToken: 'access-2' })
    await expect(session.identity()).resolves.toMatchObject({ accessToken: 'access-2' })
    expect(warn).toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('adopts the refreshed domain, which a re-issued token can change', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: true, token: refreshedToken({ domain: 'tenant.example' }) })
    await expect(new CodeBuddySession().identity()).resolves.toMatchObject({ domain: 'tenant.example' })
  })

  it('retires a disk read that was in flight when the cache was invalidated', async () => {
    // The documented contract: an invalidation must not be undone by a read
    // that was already underway. Otherwise a 401-triggered invalidation could
    // be reversed by the very snapshot it was meant to discard, and the next
    // caller would keep presenting a token the service just refused.
    let releaseRead: (value: CodeBuddyStorage | undefined) => void = () => {}
    const pending = new Promise<CodeBuddyStorage | undefined>((resolve) => { releaseRead = resolve })
    load.mockReturnValueOnce(pending)

    const session = new CodeBuddySession()
    const reading = session.identity().catch((error: unknown) => error)
    // Drop the in-memory cache while that read is still outstanding.
    session.invalidate()
    releaseRead(stored())

    // The retired read must not install the credential it started from, so the
    // caller that was waiting on it ends up signed out.
    await expect(reading).resolves.toBeInstanceOf(NotLoggedInError)
    await expect(session.isLoggedIn()).resolves.toBe(false)
    // The next caller starts a fresh read rather than reusing the retired one.
    load.mockResolvedValue(stored())
    await expect(session.isLoggedIn()).resolves.toBe(true)
  })

  it('retires an in-flight read that would install an already-expired credential', async () => {
    // The same guard covers the refresh race: a snapshot read before a refresh
    // must not land afterwards and put the old token back, which would spend
    // the rotating refresh token a second time.
    let releaseRead: (value: CodeBuddyStorage | undefined) => void = () => {}
    const pending = new Promise<CodeBuddyStorage | undefined>((resolve) => { releaseRead = resolve })
    load.mockReturnValueOnce(pending)

    const session = new CodeBuddySession()
    const reading = session.identity().catch((error: unknown) => error)
    session.invalidate()
    releaseRead(stored({ accessExpiresAt: Date.now() - 1_000 }))

    await expect(reading).resolves.toBeInstanceOf(NotLoggedInError)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('catalog', () => {
  beforeEach(() => {
    load.mockResolvedValue(stored())
  })

  it('reads the catalog once and reuses it inside the TTL', async () => {
    config.mockResolvedValue({ models: [model('a')] })
    const session = new CodeBuddySession()
    const first = await session.models()
    const second = await session.models()
    expect(config).toHaveBeenCalledTimes(1)
    // A cached read hands back the same immutable snapshot, not a copy.
    expect(second).toBe(first)
  })

  it('normalizes credit labels and drops entries with no id', async () => {
    config.mockResolvedValue({ models: [
      model('a', { credits: 'x0.34 credits' }),
      { id: '', name: 'No id' },
      model('b', { credits: 'free' }),
    ] } as never)
    const models = await new CodeBuddySession().models()
    expect(models.map(entry => entry.id)).toEqual(['a', 'b'])
    expect(models[0]?.credits).toBe('x0.34')
    // An unparseable label is dropped rather than shown verbatim.
    expect(models[1]).not.toHaveProperty('credits')
  })

  it('offers the agent-declared list in its declared order when one exists', async () => {
    config.mockResolvedValue({
      models: [model('a'), model('b'), model('c')],
      agents: [{ name: 'cli', models: ['c', 'a'] }],
    } as never)
    expect((await new CodeBuddySession().models()).map(entry => entry.id)).toEqual(['c', 'a'])
  })

  it('carries the promotions alongside the models under the same cache', async () => {
    config.mockResolvedValue({
      models: [model('a')],
      modelPromotions: [{ id: 'p1', badge: { color: '#f00', label: 'Sale' } }],
    } as never)
    const session = new CodeBuddySession()
    const data = await session.catalogData()
    expect(data.promotions).toHaveLength(1)
    await session.catalogData()
    expect(config).toHaveBeenCalledTimes(1)
  })

  it('re-reads after the TTL expires', async () => {
    vi.useFakeTimers()
    config.mockResolvedValue({ models: [model('a')] })
    const session = new CodeBuddySession()
    await session.models()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    await session.models()
    expect(config).toHaveBeenCalledTimes(2)
  })

  it('bypasses the TTL on a forced read, but not inside the force floor', async () => {
    vi.useFakeTimers()
    config.mockResolvedValue({ models: [model('a')] })
    const session = new CodeBuddySession()
    await session.models()

    // Immediately after a read, even a forced refresh serves the cache.
    await session.refreshCatalog()
    expect(config).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_001)
    await session.refreshCatalog()
    expect(config).toHaveBeenCalledTimes(2)
  })

  it('single-flights concurrent catalog reads', async () => {
    config.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return { models: [model('a')] } as never
    })
    const session = new CodeBuddySession()
    const [a, b] = await Promise.all([session.models(), session.models()])
    expect(config).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('announces a changed catalog to listeners, and stays quiet when it is unchanged', async () => {
    config.mockResolvedValue({ models: [model('a')] })
    const session = new CodeBuddySession()
    const listener = vi.fn()
    const dispose = session.onCatalogChange(listener)

    await session.models()
    // The first read has nothing to invalidate client-side.
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    await session.models()
    await session.models()
    expect(listener).not.toHaveBeenCalled()

    config.mockResolvedValue({ models: [model('a'), model('b')] })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    await session.models()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)

    dispose()
    await session.announceCatalogChange()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps announcing after a content change even when the cache was invalidated', async () => {
    config.mockResolvedValue({ models: [model('a')] })
    const session = new CodeBuddySession()
    const listener = vi.fn()
    session.onCatalogChange(listener)

    await session.models()
    session.invalidate()
    config.mockResolvedValue({ models: [model('a'), model('b')] })
    await session.models()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not let a broken listener fail the read that announced it', async () => {
    config.mockResolvedValue({ models: [model('a')] })
    const warn = vi.fn()
    const session = new CodeBuddySession({ warn, error: vi.fn() })
    session.onCatalogChange(() => { throw new Error('listener bug') })
    const seen = vi.fn()
    session.onCatalogChange(seen)

    await session.models()
    session.announceCatalogChange()
    expect(seen).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('treats an empty id list as no whitelist, falling back to the full catalog', async () => {
    config.mockResolvedValue({ models: [model('a'), model('b')], agents: [{ name: 'cli', models: ['a'] }] } as never)
    const session = new CodeBuddySession()
    await expect(session.models()).resolves.toHaveLength(1)
  })

  it('adopts the catalog without re-reading it after a token refresh', async () => {
    // The catalog is not token-scoped, but a refresh drops it deliberately;
    // the next read must then happen under the new token.
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    config.mockResolvedValue({ models: [model('a')] })
    refresh.mockResolvedValue({ ok: true, token: refreshedToken() })
    const session = new CodeBuddySession()
    await session.models()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(config).toHaveBeenCalledTimes(1)
  })

  it('drops the cached credential when the catalog read is refused with 401', async () => {
    config.mockRejectedValue(new ConfigRequestError('refused', 401))
    const session = new CodeBuddySession()
    await expect(session.models()).rejects.toBeInstanceOf(ConfigRequestError)
    // The next call re-reads the file rather than retrying a refused token.
    config.mockResolvedValue({ models: [model('a')] })
    await session.models()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the cached credential on a transient catalog failure', async () => {
    config.mockRejectedValue(new ConfigRequestError('upstream down', 503))
    const session = new CodeBuddySession()
    await expect(session.models()).rejects.toBeInstanceOf(ConfigRequestError)
    config.mockResolvedValue({ models: [model('a')] })
    await expect(session.models()).resolves.toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('degrades a failed advisory read to an empty list, with a warning', async () => {
    config.mockRejectedValue(new Error('boom'))
    const warn = vi.fn()
    const session = new CodeBuddySession({ warn, error: vi.fn() })
    await expect(session.modelsOrEmpty()).resolves.toEqual([])
    await expect(session.catalogDataOrEmpty()).resolves.toEqual({ models: [], promotions: [] })
    expect(warn).toHaveBeenCalled()
  })

  it('serves the last good catalog to a forced read that failed', async () => {
    // A transient blip must not blank every row's enrichment.
    config.mockResolvedValue({ models: [model('a', { credits: 'x2' })] })
    const session = new CodeBuddySession()
    await session.models()

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(3_001)
    config.mockRejectedValue(new Error('blip'))
    const data = await session.refreshCatalog()
    expect(data.models.map(entry => entry.id)).toEqual(['a'])
  })

  it('reports empty lists for a signed-out forced read', async () => {
    load.mockResolvedValue(undefined)
    const session = new CodeBuddySession()
    await expect(session.refreshCatalog()).resolves.toEqual({ models: [], promotions: [] })
  })
})

describe('usage', () => {
  it('resolves an identity before reading the meter', async () => {
    load.mockResolvedValue(stored())
    const snapshot = { windows: [] }
    usage.mockResolvedValue(snapshot)
    const session = new CodeBuddySession()
    await expect(session.usage()).resolves.toBe(snapshot)
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'access-1' }), undefined)
  })

  it('resolves undefined rather than propagating a meter outage', async () => {
    load.mockResolvedValue(stored())
    usage.mockResolvedValue(undefined)
    await expect(new CodeBuddySession().usage()).resolves.toBeUndefined()
  })

  it('reports undefined and warns when the identity cannot be refreshed', async () => {
    load.mockResolvedValue(stored({ accessExpiresAt: Date.now() - 1_000 }))
    refresh.mockResolvedValue({ ok: false, reason: 'unreachable' })
    const warn = vi.fn()
    const session = new CodeBuddySession({ warn, error: vi.fn() })
    await expect(session.usage()).resolves.toBeUndefined()
    expect(usage).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('does not warn for a signed-out account, which is not an error', async () => {
    load.mockResolvedValue(undefined)
    const warn = vi.fn()
    await new CodeBuddySession({ warn, error: vi.fn() }).usage()
    expect(warn).not.toHaveBeenCalled()
  })
})
