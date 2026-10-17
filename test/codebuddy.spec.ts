import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigRequestError,
  getConfig,
  getLoginAccount,
  pollAuthToken,
  refreshAccessToken,
  requestAuthState,
} from '../src/codebuddy.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'
import { CODE_AUTH_PENDING } from '../src/constants.js'

const identity: CodeBuddyIdentity = { accessToken: 'tok', domain: 'dom', uid: 'uid', site: 'cn' }

const token = {
  accessToken: 'new-token',
  expiresIn: 3600,
  refreshToken: 'new-refresh',
  refreshExpiresIn: 7200,
  domain: 'dom',
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('requestAuthState', () => {
  it('starts the handshake against the site with the no-auth markers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { state: 'st-1', authUrl: 'https://login.example/auth?state=st-1' },
    }), { status: 200 }))

    await expect(requestAuthState('intl')).resolves.toEqual({
      state: 'st-1',
      authUrl: 'https://login.example/auth?state=st-1',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    })
  })

  it('fails on a non-2xx status', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }))
    await expect(requestAuthState('cn')).rejects.toThrow(/HTTP 502/u)
  })

  it('fails on a non-zero envelope code', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 9, msg: 'refused' }), { status: 200 }))
    await expect(requestAuthState('cn')).rejects.toThrow(/9 - refused/u)
  })

  it('fails when the envelope carries no data', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }))
    await expect(requestAuthState('cn')).rejects.toThrow(/auth state request failed/u)
  })
})

describe('pollAuthToken', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('keeps polling while the service reports the pending code, then returns the tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: CODE_AUTH_PENDING }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: CODE_AUTH_PENDING }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: token }), { status: 200 }))

    const poll = pollAuthToken('cn', 'st-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(poll).resolves.toEqual(token)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://copilot.tencent.com/v2/plugin/auth/token?state=st-1')
  })

  it('encodes a state carrying URL-significant characters', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: token }), { status: 200 }))
    const poll = pollAuthToken('cn', 'a/b+c d')
    await vi.advanceTimersByTimeAsync(1_000)
    await poll
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('state=a%2Fb%2Bc%20d')
  })

  it('ends the loop on any code other than the pending one', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 42, msg: 'refused' }), { status: 200 }))
    const poll = pollAuthToken('cn', 'st-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(poll).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a non-zero code even when the body also carries a data payload', async () => {
    // The code, not the presence of `data`, is the verdict: a gateway that
    // echoes a stale token beside an error must not be read as a success.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 42, msg: 'refused', data: token }), { status: 200 }))
    const poll = pollAuthToken('cn', 'st-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(poll).resolves.toBeUndefined()
  })

  it('ends the loop on a transport fault rather than replaying a spent handshake', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const poll = pollAuthToken('cn', 'st-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(poll).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps polling through a non-2xx answer', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: token }), { status: 200 }))
    const poll = pollAuthToken('cn', 'st-1')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(poll).resolves.toEqual(token)
  })

  it('gives up after the login timeout', async () => {
    // A human who never finishes must not hold the handshake open forever.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ code: CODE_AUTH_PENDING }), { status: 200 }))
    const poll = pollAuthToken('cn', 'st-1')
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    await expect(poll).resolves.toBeUndefined()
  })

  it('stops at an aborted signal', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ code: CODE_AUTH_PENDING }), { status: 200 }))
    const poll = pollAuthToken('cn', 'st-1', controller.signal)
    const settled = poll.then(() => 'resolved', () => 'rejected')
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    // An abort is a rejection, not a decided `undefined`; the callers treat
    // both as "no token" but the distinction is visible here.
    await expect(settled).resolves.toBe('rejected')
  })
})

describe('getLoginAccount', () => {
  it('reads the account with the fresh token and the tenant domain', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { uid: 'u', nickname: 'Nick', uin: '123', enterpriseId: 'ent', enterpriseName: 'Corp', enterpriseUserName: 'nick', departmentFullName: 'R&D' },
    }), { status: 200 }))

    await expect(getLoginAccount('cn', 'st', 'tok', 'dom')).resolves.toMatchObject({
      uid: 'u',
      nickname: 'Nick',
      enterpriseId: 'ent',
      departmentFullName: 'R&D',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/login/account?state=st')
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer tok',
      'X-Domain': 'dom',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    })
  })

  it('drops empty-string optional fields so the UI renders no blank rows', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { uid: 'u', nickname: 'Nick', uin: '', enterpriseId: '', enterpriseName: '', enterpriseUserName: '', departmentFullName: '' },
    }), { status: 200 }))

    const account = await getLoginAccount('cn', 'st', 'tok', 'dom')
    expect(account).toEqual({ uid: 'u', nickname: 'Nick' })
    for (const key of ['uin', 'enterpriseId', 'enterpriseName', 'enterpriseUserName', 'departmentFullName']) {
      expect(account, key).not.toHaveProperty(key)
    }
  })

  it('fails on an HTTP refusal', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(getLoginAccount('cn', 'st', 'tok', 'dom')).rejects.toThrow(/HTTP 401/u)
  })

  it('fails on a non-zero envelope code', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 7, msg: 'denied' }), { status: 200 }))
    await expect(getLoginAccount('cn', 'st', 'tok', 'dom')).rejects.toThrow(/7 - denied/u)
  })
})

describe('refreshAccessToken', () => {
  it('posts the refresh token with the identity headers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: token }), { status: 200 }))
    await expect(refreshAccessToken({ ...identity, enterpriseId: 'ent-1' }, 'rt-old')).resolves.toEqual({ ok: true, token })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer tok',
      'X-Domain': 'dom',
      'X-User-Id': 'uid',
      'X-Refresh-Token': 'rt-old',
      'X-Enterprise-Id': 'ent-1',
    })
  })

  it('omits the tenant header for a personal identity', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: token }), { status: 200 }))
    await refreshAccessToken(identity, 'rt')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Enterprise-Id']).toBeUndefined()
  })

  it('reports a transport fault as unreachable, not as a refusal', async () => {
    // A user with a healthy credential must not be told to sign in again
    // because their network blipped.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('reports a decided 4xx as a refusal', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      fetchMock.mockResolvedValue(new Response('{}', { status }))
      await expect(refreshAccessToken(identity, 'rt'), String(status)).resolves.toEqual({ ok: false, reason: 'rejected' })
    }
  })

  it('reports the retryable statuses and server faults as unreachable', async () => {
    for (const status of [408, 429, 500, 503]) {
      fetchMock.mockResolvedValue(new Response('{}', { status }))
      await expect(refreshAccessToken(identity, 'rt'), String(status)).resolves.toEqual({ ok: false, reason: 'unreachable' })
    }
  })

  it('reports a 200 whose body cannot be read as unreachable', async () => {
    // A broken reply is not a verdict on the credential.
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'unreachable' })
  })

  it('reports a non-zero envelope code as a refusal', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 5, msg: 'spent' }), { status: 200 }))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'rejected' })
  })

  it('reports a zero code with no token payload as a refusal, not as success', async () => {
    // A 200 with `{code: 0}` and no `data` carries no tokens to hand back.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, msg: 'ok' }), { status: 200 }))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'rejected' })
  })

  it('reports a zero code with no data as a refusal', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }))
    await expect(refreshAccessToken(identity, 'rt')).resolves.toEqual({ ok: false, reason: 'rejected' })
  })
})

describe('getConfig', () => {
  it('reads the catalog with the site-specific agent', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { models: [{ id: 'm', name: 'M' }] },
    }), { status: 200 }))

    await expect(getConfig(identity)).resolves.toEqual({ models: [{ id: 'm', name: 'M' }] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/v3/config')
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({
      'User-Agent': 'CodeBuddyIDE/4.12.0',
      'Authorization': 'Bearer tok',
      'X-Domain': 'dom',
      'X-User-Id': 'uid',
    })
  })

  it('sends the international catalog agent and the tenant headers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { models: [] } }), { status: 200 }))
    await getConfig({ ...identity, site: 'intl', enterpriseId: 'ent-1', departmentFullName: 'R&D' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.codebuddy.ai/v3/config')
    expect(init.headers).toMatchObject({
      'User-Agent': 'WorkBuddy/5.7.2 CLI/2.156.0',
      'X-Enterprise-Id': 'ent-1',
      'X-Department-Info': 'R&D',
    })
  })

  it('carries the HTTP status on a refusal, so the caller can tell auth from an outage', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    const error = await getConfig(identity).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConfigRequestError)
    expect(error).toMatchObject({ status: 401, message: expect.stringContaining('HTTP 401') as unknown as string })
  })

  it('leaves the status undefined when no HTTP verdict was reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const error = await getConfig(identity).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConfigRequestError)
    expect(error).toMatchObject({ status: undefined })
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(TypeError)
  })

  it('fails on a non-zero envelope code without a status', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 3, msg: 'bad' }), { status: 200 }))
    const error = await getConfig(identity).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: undefined, message: expect.stringContaining('3 - bad') as unknown as string })
  })

  it('fails when the envelope carries no catalog', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }))
    await expect(getConfig(identity)).rejects.toThrow(/config request failed/u)
  })
})
