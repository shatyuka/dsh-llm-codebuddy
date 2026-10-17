import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStorage, login } from '../src/login.js'
import { loadStorage } from '../src/storage.js'
import type { Account, AuthToken } from '../src/types.js'

const token: AuthToken = {
  accessToken: 'access-1',
  expiresIn: 3_600,
  refreshToken: 'refresh-1',
  refreshExpiresIn: 7_200,
  domain: 'corp.example',
}

const account: Account = { uid: 'uid-1', nickname: 'Nick' }

let home: string

beforeEach(async () => {
  // `login` persists through the real store, so the store must be pointed at
  // a throwaway directory rather than the user's own credential file.
  home = await mkdtemp(join(tmpdir(), 'codebuddy-login-'))
  process.env['DSH_CODEBUDDY_AUTH_FILE'] = join(home, 'codebuddy-auth.json')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete process.env['DSH_CODEBUDDY_AUTH_FILE']
  await rm(home, { recursive: true, force: true })
})

describe('buildStorage', () => {
  it('turns the token lifetimes into absolute expiries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-05-01T00:00:00Z'))

    const storage = buildStorage('intl', token, account)
    expect(storage).toEqual({
      site: 'intl',
      auth: {
        accessToken: 'access-1',
        expiresAt: Date.parse('2024-05-01T00:00:00Z') + 3_600_000,
        refreshToken: 'refresh-1',
        refreshExpiresAt: Date.parse('2024-05-01T00:00:00Z') + 7_200_000,
        domain: 'corp.example',
      },
      account: { uid: 'uid-1', nickname: 'Nick' },
    })
  })

  it('records the site the tokens were issued by', () => {
    expect(buildStorage('cn', token, account).site).toBe('cn')
    expect(buildStorage('intl', token, account).site).toBe('intl')
  })

  it('carries every disclosed account fact', () => {
    const storage = buildStorage('cn', token, {
      uid: 'u',
      nickname: 'N',
      uin: '123',
      enterpriseId: 'ent',
      enterpriseName: 'Corp',
      enterpriseUserName: 'nick',
      departmentFullName: 'R&D/Platform',
    })
    expect(storage.account).toEqual({
      uid: 'u',
      nickname: 'N',
      uin: '123',
      enterpriseId: 'ent',
      enterpriseName: 'Corp',
      enterpriseUserName: 'nick',
      departmentFullName: 'R&D/Platform',
    })
  })

  it('omits the optional fields a personal account does not disclose', () => {
    // Only `undefined` means absent downstream, so the keys must not be
    // present at all rather than set to undefined.
    const written = buildStorage('cn', token, account)
    for (const key of ['uin', 'enterpriseId', 'enterpriseName', 'enterpriseUserName', 'departmentFullName']) {
      expect(written.account, key).not.toHaveProperty(key)
    }
  })
})

describe('login', () => {
  it('drives the handshake through to a persisted credential', async () => {
    // The flow's three network reads and the write are exercised end to end
    // through the real modules, with only `fetch` and the store stubbed.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v2/plugin/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://login.example/st-1' } }), { status: 200 })
      }
      if (url.includes('/v2/plugin/auth/token')) {
        return new Response(JSON.stringify({ code: 0, data: token }), { status: 200 })
      }
      if (url.includes('/v2/plugin/login/account')) {
        return new Response(JSON.stringify({ code: 0, data: account }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // The poll waits one interval before its first request; that timer is the
    // only thing on the fake clock here.
    vi.useFakeTimers()
    const onUrl = vi.fn()
    const result = login({ site: 'intl', openBrowser: false, onUrl })
    await vi.advanceTimersByTimeAsync(1_000)
    const settled = await result

    expect(onUrl).toHaveBeenCalledWith('https://login.example/st-1')
    expect(settled.nickname).toBe('Nick')
    expect(settled.storage).toMatchObject({
      site: 'intl',
      auth: expect.objectContaining({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
      account: { uid: 'uid-1', nickname: 'Nick' },
    })
    // The credential is on disk where a running harness will find it.
    await expect(loadStorage()).resolves.toEqual(settled.storage)
  })

  it('fails with a sign-in explanation when the handshake is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/v2/plugin/auth/state')) {
        return new Response(JSON.stringify({ code: 0, data: { state: 'st-1', authUrl: 'https://login.example/st-1' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 42, msg: 'refused' }), { status: 200 })
    }))

    vi.useFakeTimers()
    const settled = login({ openBrowser: false }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/did not complete/u)
    // A refused handshake must not leave a credential behind.
    await expect(loadStorage()).resolves.toBeUndefined()
  })
})
