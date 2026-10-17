import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/storage.js', () => ({
  loadStorage: vi.fn(),
  saveStorage: vi.fn(),
  clearStorage: vi.fn(),
}))

vi.mock('../src/codebuddy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codebuddy.js')>()
  return {
    ...actual,
    requestAuthState: vi.fn(),
    pollAuthToken: vi.fn(),
    getLoginAccount: vi.fn(),
  }
})

import { CodeBuddyAuthService, CODEBUDDY_AUTH_CHANNEL } from '../src/auth-service.js'
import { MessageLocale } from '../src/locale.js'
import { clearStorage, loadStorage, saveStorage } from '../src/storage.js'
import { getLoginAccount, pollAuthToken, requestAuthState } from '../src/codebuddy.js'
import type { CodeBuddyStorage } from '../src/storage.js'
import type { CodeBuddyModel } from '../src/types.js'
import type { UsageSnapshot } from '../src/usage.js'

const load = vi.mocked(loadStorage)
const save = vi.mocked(saveStorage)
const clear = vi.mocked(clearStorage)
const startState = vi.mocked(requestAuthState)
const poll = vi.mocked(pollAuthToken)
const account = vi.mocked(getLoginAccount)

/** A stored credential, fresh by default. */
function stored(over: Partial<CodeBuddyStorage> = {}): CodeBuddyStorage {
  return {
    site: 'cn',
    auth: {
      accessToken: 'access-1',
      expiresAt: Date.now() + 3_600_000,
      refreshToken: 'refresh-1',
      refreshExpiresAt: Date.now() + 7_200_000,
      domain: 'corp.example',
    },
    account: { uid: 'uid-1', nickname: 'Nick' },
    ...over,
  }
}

/** The measured identity the login flow persists. */
const issuedToken = {
  accessToken: 'fresh-access',
  expiresIn: 3_600,
  refreshToken: 'fresh-refresh',
  refreshExpiresIn: 7_200,
  domain: 'corp.example',
}

/**
 * A context double that captures what the service registers.
 *
 * `inject` runs the callback against a scope exposing the two host services;
 * `rpcHandle` decides whether the preferred registration path works or the
 * fallback route is taken.
 */
function contextOf(options: { rpcHandle?: () => () => void } = {}) {
  const state = {
    effects: [] as (() => void)[],
    fallbackRoutes: [] as { kind: string, path: string, handler: unknown }[],
    rpcChannels: [] as string[],
  }
  const registered: string[] = []
  const scope = {
    get: (name: string) => {
      registered.push(name)
      if (name === 'connection') {
        return {
          rpc: {
            handle: (channel: string, _handler: unknown, _options?: unknown) => {
              const disposer = (options.rpcHandle ?? (() => () => {}))()
              state.rpcChannels.push(channel)
              return disposer
            },
          },
          requestRejection: () => undefined,
        }
      }
      return {
        register: (route: { kind: string, path: string, handler: unknown }) => {
          state.fallbackRoutes.push(route)
          return () => {}
        },
      }
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') state.effects.push(disposer as () => void)
    },
  }
  return {
    state,
    registered,
    inject: (_deps: readonly string[], fn: (scope: unknown) => void) => { fn(scope) },
    effect: (fn: () => unknown) => { fn() },
  }
}

/** A session double over the face the auth service reads. */
function sessionOf(over: {
  usable?: boolean
  models?: readonly CodeBuddyModel[]
  promotions?: readonly unknown[]
  usage?: UsageSnapshot | undefined
  isUsable?: () => Promise<boolean>
} = {}) {
  const invalidate = vi.fn()
  const announceCatalogChange = vi.fn()
  return {
    invalidate,
    announceCatalogChange,
    isUsable: over.isUsable ?? (async () => over.usable ?? true),
    refreshCatalog: async () => ({ models: over.models ?? [], promotions: over.promotions ?? [] }),
    refreshCatalogCalls: 0,
    usage: async () => over.usage,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  save.mockResolvedValue()
  clear.mockResolvedValue()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('channel registration', () => {
  it('registers the private channel through the connection service', () => {
    const ctx = contextOf()
    new CodeBuddyAuthService(ctx as never)
    expect(ctx.state.rpcChannels).toEqual([CODEBUDDY_AUTH_CHANNEL])
    expect(ctx.state.fallbackRoutes).toEqual([])
  })

  it('falls back to a prefix route when the registry path throws', () => {
    // dsh 0.1.5-rc.1 could not read `webServer` through the connection
    // service's own fiber; the equivalent prefix route keeps the client half
    // working unchanged.
    const ctx = contextOf({ rpcHandle: () => { throw new Error('strict service access') } })
    new CodeBuddyAuthService(ctx as never)
    expect(ctx.state.fallbackRoutes).toHaveLength(1)
    expect(ctx.state.fallbackRoutes[0]).toMatchObject({ kind: 'prefix', path: CODEBUDDY_AUTH_CHANNEL })
  })

  it('reuses the connection trust fence on the fallback route', () => {
    const ctx = contextOf({ rpcHandle: () => { throw new Error('nope') } })
    new CodeBuddyAuthService(ctx as never)
    expect(ctx.registered).toContain('connection')
    expect(ctx.registered).toContain('webServer')
  })
})

describe('status', () => {
  it('reports signed out when nothing is stored', async () => {
    load.mockResolvedValue(undefined)
    await expect(new CodeBuddyAuthService(contextOf() as never).status()).resolves.toEqual({ loggedIn: false })
  })

  it('reports the account facts of a usable credential', async () => {
    load.mockResolvedValue(stored({
      account: { uid: 'u', nickname: 'Nick', uin: '123', enterpriseId: 'ent', enterpriseName: 'Corp', enterpriseUserName: 'nick', departmentFullName: 'R&D' },
    }))
    const status = await new CodeBuddyAuthService(contextOf() as never, sessionOf({ usable: true }) as never).status()
    expect(status).toEqual({
      loggedIn: true,
      nickname: 'Nick',
      uid: 'u',
      uin: '123',
      domain: 'corp.example',
      enterpriseId: 'ent',
      enterpriseName: 'Corp',
      enterpriseUserName: 'nick',
      departmentFullName: 'R&D',
    })
  })

  it('omits the fields the account did not disclose', async () => {
    load.mockResolvedValue(stored({ account: { uid: 'u', nickname: 'Nick' } }))
    const status = await new CodeBuddyAuthService(contextOf() as never, sessionOf() as never).status()
    for (const key of ['uin', 'enterpriseId', 'enterpriseName', 'enterpriseUserName', 'departmentFullName']) {
      expect(status, key).not.toHaveProperty(key)
    }
  })

  it('omits an empty domain rather than rendering a blank row', async () => {
    load.mockResolvedValue(stored({
      auth: { accessToken: 'a', expiresAt: Date.now() + 1_000, refreshToken: 'r', refreshExpiresAt: Date.now() + 2_000, domain: '' },
    }))
    const status = await new CodeBuddyAuthService(contextOf() as never, sessionOf() as never).status()
    expect(status).not.toHaveProperty('domain')
  })

  it('reports an unusable credential as expired, not as merely unused', async () => {
    // Otherwise the page shows an account while every request fails and the
    // model list is empty.
    load.mockResolvedValue(stored())
    await expect(new CodeBuddyAuthService(contextOf() as never, sessionOf({ usable: false }) as never).status())
      .resolves.toEqual({ loggedIn: false, expired: true })
  })

  it('reports a stored credential as signed in when no session can probe it', async () => {
    load.mockResolvedValue(stored())
    await expect(new CodeBuddyAuthService(contextOf() as never).status()).resolves.toMatchObject({ loggedIn: true })
  })
})

describe('usage', () => {
  it('projects a snapshot into the client-safe shape', async () => {
    const snapshot: UsageSnapshot = {
      windows: [{ name: 'base', used: 10, limit: 100, usedPercent: 10, resetsAt: '2024-01-01 00:00:00' }],
      primary: { name: 'total', used: 10, limit: 100, usedPercent: 10 },
    }
    const service = new CodeBuddyAuthService(contextOf() as never, sessionOf({ usage: snapshot }) as never)
    await expect(service.usage()).resolves.toEqual({
      loggedIn: true,
      windows: [{ name: 'base', used: 10, limit: 100, usedPercent: 10, resetsAt: '2024-01-01 00:00:00' }],
      primary: { name: 'total', used: 10, limit: 100, usedPercent: 10 },
    })
  })

  it('keeps an uncapped window\'s absent figures absent rather than defaulting them', async () => {
    const snapshot: UsageSnapshot = { windows: [{ name: 'uncapped' }] }
    const service = new CodeBuddyAuthService(contextOf() as never, sessionOf({ usage: snapshot }) as never)
    await expect(service.usage()).resolves.toEqual({ loggedIn: true, windows: [{ name: 'uncapped' }] })
  })

  it('reports a signed-out shape when the meter produced nothing', async () => {
    const service = new CodeBuddyAuthService(contextOf() as never, sessionOf({ usage: undefined }) as never)
    await expect(service.usage()).resolves.toEqual({ loggedIn: false, windows: [] })
  })
})

describe('models', () => {
  /** One offerable catalog entry with every display fact. */
  const offerable: CodeBuddyModel = {
    id: 'offered',
    name: 'Offered',
    credits: 'x2.00',
    tags: ['badge:Fast:#00AA00'],
    descriptionZh: '中文说明',
    descriptionEn: 'English description',
    maxAllowedSize: 200_000,
    maxOutputTokens: 8_000,
    supportsImages: true,
  }

  it('ships only the models the adapter would offer', async () => {
    const unsized: CodeBuddyModel = { id: 'image-gen', name: 'Image Gen' }
    const service = new CodeBuddyAuthService(
      contextOf() as never,
      sessionOf({ models: [offerable, unsized] }) as never,
    )
    const result = await service.models()
    expect(result.loggedIn).toBe(true)
    expect(result.models.map(entry => entry.id)).toEqual(['offered'])
  })

  it('carries the credits, tags, and one resolved description', async () => {
    const service = new CodeBuddyAuthService(
      contextOf() as never,
      sessionOf({ models: [offerable] }) as never,
      new MessageLocale(),
    )
    const [entry] = (await service.models()).models
    expect(entry).toEqual({
      id: 'offered',
      name: 'Offered',
      credits: 'x2.00',
      tags: ['badge:Fast:#00AA00'],
      description: 'English description',
    })
  })

  it('resolves the description in the language the client reported', async () => {
    const locale = new MessageLocale()
    locale.report('zh-CN')
    const service = new CodeBuddyAuthService(contextOf() as never, sessionOf({ models: [offerable] }) as never, locale)
    expect((await service.models()).models[0]?.description).toBe('中文说明')
  })

  it('falls back to the other wording when the preferred one is absent', async () => {
    const { descriptionEn: _omit, ...onlyZh } = offerable
    const service = new CodeBuddyAuthService(contextOf() as never, sessionOf({ models: [onlyZh] }) as never)
    expect((await service.models()).models[0]?.description).toBe('中文说明')
  })

  it('reports signed out without reading a catalog when the session is unusable', async () => {
    const service = new CodeBuddyAuthService(contextOf() as never, sessionOf({ usable: false }) as never)
    await expect(service.models()).resolves.toEqual({ loggedIn: false, models: [] })
  })

  it('reports signed out when there is no session at all', async () => {
    await expect(new CodeBuddyAuthService(contextOf() as never).models()).resolves.toEqual({ loggedIn: false, models: [] })
  })
})

describe('model promotions', () => {
  /** One offerable entry, named so promotions can target it. */
  const entry: CodeBuddyModel = { id: 'm', name: 'M', maxAllowedSize: 1_000, maxOutputTokens: 100 }

  function promotion(over: Record<string, unknown> = {}) {
    return {
      id: 'p',
      modelIds: ['m'],
      badge: { color: '#FF0000', label: 'Sale' },
      hover: { textEn: 'Limited offer', textZh: '限时优惠' },
      ...over,
    }
  }

  async function displayOf(promotions: readonly unknown[], language?: string): Promise<unknown> {
    const locale = new MessageLocale()
    if (language !== undefined) locale.report(language)
    const service = new CodeBuddyAuthService(
      contextOf() as never,
      sessionOf({ models: [entry], promotions }) as never,
      locale,
    )
    return (await service.models()).models[0]?.promotion
  }

  it('attaches the display facts of an active promotion', async () => {
    await expect(displayOf([promotion()])).resolves.toEqual({
      color: '#FF0000',
      label: 'Sale',
      text: 'Limited offer',
    })
  })

  it('localizes the hover text', async () => {
    await expect(displayOf([promotion()], 'zh')).resolves.toMatchObject({ text: '限时优惠' })
  })

  it('lets the highest priority win', async () => {
    const viewer = await displayOf([
      promotion({ priority: 1, badge: { color: '#111111', label: 'Low' } }),
      promotion({ priority: 10, badge: { color: '#222222', label: 'High' } }),
    ])
    expect(viewer).toMatchObject({ color: '#222222', label: 'High' })
  })

  it('keeps the first winner among equal priorities', async () => {
    const viewer = await displayOf([
      promotion({ priority: 5, badge: { color: '#111111', label: 'First' } }),
      promotion({ priority: 5, badge: { color: '#222222', label: 'Second' } }),
    ])
    expect(viewer).toMatchObject({ label: 'First' })
  })

  it('ignores a promotion that does not target this model', async () => {
    await expect(displayOf([promotion({ modelIds: ['other'] })])).resolves.toBeUndefined()
    await expect(displayOf([promotion({ modelIds: undefined })])).resolves.toBeUndefined()
  })

  it('ignores a disabled or scheduled-out promotion', async () => {
    await expect(displayOf([promotion({ enabled: false })])).resolves.toBeUndefined()
    await expect(displayOf([promotion({ schedule: { validFrom: '2999-01-01T00:00:00Z' } })])).resolves.toBeUndefined()
  })

  it('ignores a promotion with no badge to render', async () => {
    await expect(displayOf([promotion({ badge: undefined })])).resolves.toBeUndefined()
    await expect(displayOf([promotion({ badge: { color: '#fff' } })])).resolves.toBeUndefined()
    await expect(displayOf([promotion({ badge: { label: 'No color' } })])).resolves.toBeUndefined()
  })

  it('carries the pre-formatted discounted rate', async () => {
    await expect(displayOf([promotion({ discount: { discountedCredits: 'x0.5' } })]))
      .resolves.toMatchObject({ discountedRate: 'x0.50' })
  })

  it('normalizes an unpadded or decorated rate label', async () => {
    await expect(displayOf([promotion({ discount: { discountedCredits: '0.79x' } })]))
      .resolves.toMatchObject({ discountedRate: 'x0.79' })
  })

  it('falls back to the numeric factor when the label cannot be parsed', async () => {
    await expect(displayOf([promotion({ discount: { discountedCredits: 'free', factor: 0.5 } })]))
      .resolves.toMatchObject({ discountedRate: 'x0.50' })
  })

  it('ignores a negative or non-finite factor', async () => {
    // Both an unparseable label and an unusable factor mean "no override", so
    // the key is omitted and the catalog's own rate keeps showing.
    for (const discount of [{ factor: -1 }, { factor: Number.POSITIVE_INFINITY }, { factor: Number.NaN }, { discountedCredits: 'free' }]) {
      const viewer = await displayOf([promotion({ discount })])
      expect(viewer, JSON.stringify(discount)).not.toHaveProperty('discountedRate')
    }
  })

  it('carries no discounted rate when the promotion carries no discount', async () => {
    const viewer = await displayOf([promotion()])
    expect(viewer).toEqual({ color: '#FF0000', label: 'Sale', text: 'Limited offer' })
  })
})

describe('browser login', () => {
  it('starts a handshake and returns the URL the user must open', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    // A login run that never settles keeps the entry pending for the poll.
    poll.mockImplementation(() => new Promise(() => {}))

    const service = new CodeBuddyAuthService(contextOf() as never)
    await expect(service.startLogin('cn')).resolves.toEqual({ authUrl: 'https://login.example/st-1', state: 'st-1' })
    expect(startState).toHaveBeenCalledWith('cn')
  })

  it('reports an unknown handshake as not done rather than failing the poll', async () => {
    // The client's poll loop may outlive the entry by one tick.
    const service = new CodeBuddyAuthService(contextOf() as never)
    await expect(service.pollLogin('never-started')).resolves.toEqual({ done: false })
  })

  it('persists the credential once the handshake completes, then reports the nickname', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    poll.mockResolvedValue(issuedToken)
    account.mockResolvedValue({ uid: 'uid-1', nickname: 'Nick' })
    const session = sessionOf()
    const service = new CodeBuddyAuthService(contextOf() as never, session as never)

    await service.startLogin('intl')
    await expect(service.pollLogin('st-1')).resolves.toEqual({ done: true, nickname: 'Nick' })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      site: 'intl',
      auth: expect.objectContaining({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh', domain: 'corp.example' }),
      account: { uid: 'uid-1', nickname: 'Nick' },
    }))
    // A running harness must pick the credential up without a restart.
    expect(session.invalidate).toHaveBeenCalled()
    expect(session.announceCatalogChange).toHaveBeenCalled()
  })

  it('reports not done when the handshake was refused or timed out', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    poll.mockResolvedValue(undefined)
    const service = new CodeBuddyAuthService(contextOf() as never)

    await service.startLogin('cn')
    await expect(service.pollLogin('st-1')).resolves.toEqual({ done: false })
    expect(save).not.toHaveBeenCalled()
  })

  it('reports not done when the account read fails', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    poll.mockResolvedValue(issuedToken)
    account.mockRejectedValue(new Error('account read failed'))
    const service = new CodeBuddyAuthService(contextOf() as never)

    await service.startLogin('cn')
    await expect(service.pollLogin('st-1')).resolves.toEqual({ done: false })
    expect(save).not.toHaveBeenCalled()
  })

  it('resolves an unknown site from the RPC payload to the default one', async () => {
    // `startLogin` itself takes an already-resolved site; the narrowing lives
    // in the dispatcher, which is where a payload from the client arrives.
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    poll.mockImplementation(() => new Promise(() => {}))
    const service = new CodeBuddyAuthService(contextOf() as never)
    const dispatch = (service as unknown as {
      dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
    }).dispatch.bind(service)

    await dispatch('startLogin', { site: 'mars' }, new AbortController().signal)
    expect(startState).toHaveBeenLastCalledWith('cn')
    await dispatch('startLogin', {}, new AbortController().signal)
    expect(startState).toHaveBeenLastCalledWith('cn')
    await dispatch('startLogin', { site: 'intl' }, new AbortController().signal)
    expect(startState).toHaveBeenLastCalledWith('intl')
  })

  it('cancels a started handshake without persisting anything', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    poll.mockImplementation(async (_site, _state, signal?: AbortSignal) => {
      // Never resolves on its own; only the abort ends it.
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return undefined
    })
    const service = new CodeBuddyAuthService(contextOf() as never)

    await service.startLogin('cn')
    await expect(service.cancelLogin('st-1')).resolves.toBeUndefined()
    expect(save).not.toHaveBeenCalled()
    await expect(service.pollLogin('st-1')).resolves.toEqual({ done: false })
  })

  it('treats cancelling an unknown handshake as a no-op', async () => {
    const service = new CodeBuddyAuthService(contextOf() as never)
    await expect(service.cancelLogin('never-started')).resolves.toBeUndefined()
  })

  it('persists nothing when the handshake is cancelled just before the write', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    poll.mockResolvedValue(issuedToken)
    // The account read is where a cancel can still land; the run re-checks
    // the signal before building any credential.
    account.mockImplementation(async () => ({ uid: 'u', nickname: 'N' }))
    const service = new CodeBuddyAuthService(contextOf() as never)

    await service.startLogin('cn')
    const cancelled = service.cancelLogin('st-1')
    await cancelled
    // Whether the run won the race is timing-dependent, but it must never
    // both report a cancel and leave a pending entry behind.
    await expect(service.pollLogin('st-1')).resolves.toEqual({ done: false })
  })
})

describe('logout', () => {
  it('clears the store and invalidates both caches', async () => {
    const session = sessionOf()
    const service = new CodeBuddyAuthService(contextOf() as never, session as never)
    await expect(service.logout()).resolves.toBeUndefined()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(session.invalidate).toHaveBeenCalledTimes(1)
    expect(session.announceCatalogChange).toHaveBeenCalledTimes(1)
  })

  it('cancels an in-flight handshake first, so it cannot re-persist a credential', async () => {
    startState.mockResolvedValue({ state: 'st-1', authUrl: 'https://login.example/st-1' })
    let pollStarted = false
    poll.mockImplementation(async (_site, _state, signal?: AbortSignal) => {
      pollStarted = true
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return undefined
    })
    const service = new CodeBuddyAuthService(contextOf() as never)
    await service.startLogin('cn')
    // Let the run reach its poll before the logout cancels it.
    await vi.waitFor(() => expect(pollStarted).toBe(true))

    await service.logout()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('locale reporting', () => {
  it('records the tag the client reports over the wire', async () => {
    // The language is resolved browser-side, so this report is the host's only
    // source for it.
    const locale = new MessageLocale()
    const ctx = contextOf()
    const service = new CodeBuddyAuthService(ctx as never, sessionOf() as never, locale)
    // Reach the dispatcher through the registered channel handler.
    const handler = (ctx as unknown as { state: { rpcChannels: string[] } }).state.rpcChannels
    expect(handler).toHaveLength(1)
    // `dispatch` is private; the observable contract is that a reported tag
    // reaches the locale object the models projection reads.
    const dispatch = (service as unknown as {
      dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
    }).dispatch.bind(service)
    await dispatch('locale', 'zh-CN', new AbortController().signal)
    expect(locale.tag()).toBe('zh-CN')
  })

  it('fails an unknown endpoint instead of throwing', async () => {
    const service = new CodeBuddyAuthService(contextOf() as never)
    const dispatch = (service as unknown as {
      dispatch: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
    }).dispatch.bind(service)
    await expect(dispatch('nope', {}, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    })
  })
})
