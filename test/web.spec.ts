import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_TOOL_DEFAULT_RESULTS,
  AGENT_TOOL_MAX_RESULTS,
  CODEBUDDY_FETCH_PROVIDER_ID,
  CODEBUDDY_SEARCH_PROVIDER_ID,
  CodeBuddyWebFetchProvider,
  CodeBuddyWebSearchProvider,
} from '../src/web.js'
import { NotLoggedInError } from '../src/session.js'
import type { CodeBuddySession } from '../src/session.js'
import type { CodeBuddyIdentity } from '../src/codebuddy.js'

const identity: CodeBuddyIdentity = { accessToken: 'tok', domain: 'dom', uid: 'uid', site: 'cn' }

/**
 * A session stub: the providers read only these two members, so standing in for
 * the whole class keeps each test to the behaviour it is about.
 */
function sessionOf(overrides: { loggedIn?: boolean } = {}): CodeBuddySession {
  return {
    identity: vi.fn(async () => {
      if (overrides.loggedIn === false) throw new NotLoggedInError('not signed in')
      return identity
    }),
    authHeaders: vi.fn(async () => ({
      'Authorization': 'Bearer tok',
      'X-Domain': 'dom',
      'X-User-Id': 'uid',
    })),
    isLoggedIn: vi.fn(async () => overrides.loggedIn !== false),
    isUsable: vi.fn(async () => overrides.loggedIn !== false),
    invalidate: vi.fn(),
  } as unknown as CodeBuddySession
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('provider identity', () => {
  it('registers a distinct id per capability', () => {
    const session = sessionOf()
    const search = new CodeBuddyWebSearchProvider(session)
    const fetch = new CodeBuddyWebFetchProvider(session)
    expect(search.id).toBe(CODEBUDDY_SEARCH_PROVIDER_ID)
    expect(fetch.id).toBe(CODEBUDDY_FETCH_PROVIDER_ID)
    // Each menu pins its own id, so a shared one would make the two
    // selections impossible to tell apart in a profile.
    expect(search.id).not.toBe(fetch.id)
  })

  it('names itself for the provider picker', () => {
    // The picker shows the raw id for a provider that declares no title, so the
    // display name is what keeps the menu readable.
    const session = sessionOf()
    const search = new CodeBuddyWebSearchProvider(session)
    const fetch = new CodeBuddyWebFetchProvider(session)
    expect(search.title).toBe('CodeBuddy Web Search')
    expect(fetch.title).toBe('CodeBuddy Web Fetch')
    // English is required by the seam; the Chinese wording is what a zh client
    // resolves to.
    expect(search.description.en.length).toBeGreaterThan(0)
    expect(search.description.zh.length).toBeGreaterThan(0)
    expect(fetch.description.en.length).toBeGreaterThan(0)
    expect(fetch.description.zh.length).toBeGreaterThan(0)
    // The two pickers explain different capabilities, so the wording differs.
    expect(fetch.description).not.toEqual(search.description)
  })

  it('is always available but ready only with a usable credential', async () => {
    const signedOut = sessionOf({ loggedIn: false })
    const search = new CodeBuddyWebSearchProvider(signedOut)
    // Availability is a synchronous local check the seam forbids blocking in,
    // so it answers true and leaves the credential to `ready`.
    expect(search.available()).toBe(true)
    await expect(search.ready(undefined)).resolves.toBe(false)
    await expect(new CodeBuddyWebFetchProvider(sessionOf()).ready(undefined)).resolves.toBe(true)
  })

  it('asks the session whether the credential is usable, not merely stored', async () => {
    // An expired access token with an expired refresh token reads as signed in
    // but fails every call, so a stored file alone must not advertise the tool.
    const session = sessionOf()
    await new CodeBuddyWebSearchProvider(session).ready('codebuddy')
    await new CodeBuddyWebFetchProvider(session).ready('codebuddy')
    expect(session.isUsable).toHaveBeenCalledTimes(2)
    expect(session.isLoggedIn).not.toHaveBeenCalled()
  })
})

describe('search', () => {
  it('posts the query to the site\'s search plane with the identity headers', async () => {
    fetchMock.mockResolvedValue(json({
      query: 'q',
      provider: '1',
      results: [{ title: 'T', url: 'https://example.test/a', snippet: 'S', site: 'Site', favicon: 'f' }],
      total_results: 1,
    }))

    const result = await new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer tok',
      'X-Domain': 'dom',
      'X-User-Id': 'uid',
      'content-type': 'application/json',
    })
    expect((init.headers as Record<string, string>)['X-Request-ID']).toMatch(/^[0-9a-f]{32}$/u)
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'q',
      type: 'text2text',
      max_results: AGENT_TOOL_DEFAULT_RESULTS,
    })
    expect(result).toEqual({
      sources: [{ url: 'https://example.test/a', title: 'T', snippet: 'S' }],
      truncated: false,
    })
  })

  it('never asks for more hits than the service accepts', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    await new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q', maxResults: 50 })
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).max_results)
      .toBe(AGENT_TOOL_MAX_RESULTS)
  })

  it('forwards the caller\'s signal', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    const controller = new AbortController()
    await new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }, controller.signal)
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal)
  })

  it('drops a hit without a URL, which cannot be cited', async () => {
    fetchMock.mockResolvedValue(json({
      results: [{ title: 'no url' }, { url: '', title: 'empty' }, { url: 'https://ok.test/' }],
    }))
    const result = await new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://ok.test/' }])
  })

  it('reports an empty result set without inventing sources', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    await expect(new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })

  it('fails with a sign-in remedy when nothing is stored', async () => {
    await expect(new CodeBuddyWebSearchProvider(sessionOf({ loggedIn: false })).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringMatching(/not signed in/u) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the service\'s refusal with its status and message', async () => {
    fetchMock.mockResolvedValue(json({ code: 15001, msg: 'Web Search exceeds frequency limit!' }, 429))
    await expect(new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }))
      .rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message: expect.stringMatching(/HTTP 429.*Web Search exceeds frequency limit/u),
      })
  })

  it('maps a URL-safety refusal onto the seam\'s blocked-URL code', async () => {
    fetchMock.mockResolvedValue(json({ code: 15018, msg: 'forbidden domain: localhost' }, 403))
    await expect(new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('drops the stored credential when the service rejects it', async () => {
    const session = sessionOf()
    // The fronting proxy answers a refused token with HTML, not an envelope.
    fetchMock.mockResolvedValue(new Response('<html>401</html>', { status: 401 }))
    await expect(new CodeBuddyWebSearchProvider(session).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringMatching(/sign in again/u) })
    expect(session.invalidate).toHaveBeenCalled()
  })

  it('marks a cancellation as aborted rather than as a provider fault', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async () => {
      controller.abort()
      throw new TypeError('fetch failed')
    })
    await expect(new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('reports a transport fault as a provider error carrying its cause', async () => {
    const cause = new TypeError('fetch failed')
    fetchMock.mockRejectedValue(cause)
    await expect(new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', cause })
  })

  it('reports an unreadable body rather than resolving empty', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(new CodeBuddyWebSearchProvider(sessionOf()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringMatching(/unreadable/u) })
  })

  it('follows an international credential to its own host', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    const session = {
      identity: vi.fn(async () => ({ ...identity, site: 'intl' as const })),
      authHeaders: vi.fn(async () => ({ 'Authorization': 'Bearer tok' })),
      isLoggedIn: vi.fn(async () => true),
      invalidate: vi.fn(),
    } as unknown as CodeBuddySession
    await new CodeBuddyWebSearchProvider(session).search({ query: 'q' })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://www.codebuddy.ai/agenttool/v1/search')
  })
})

describe('fetch', () => {
  it('reports the target page\'s status and the rendered body', async () => {
    fetchMock.mockResolvedValue(json({
      url: 'https://example.test/page',
      title: 'T',
      content: '# Body',
      content_type: 'text/markdown',
      status_code: 404,
      truncated: true,
    }))

    const result = await new CodeBuddyWebFetchProvider(sessionOf()).fetch({ url: 'https://example.test/page' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://copilot.tencent.com/agenttool/v1/webfetch')
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.test/page' })
    expect(result).toEqual({
      url: 'https://example.test/page',
      // The envelope answered 200; the page itself did not.
      statusCode: 404,
      body: { kind: 'text', content: '# Body' },
      truncated: true,
    })
  })

  it('falls back to the requested URL when the reply names none', async () => {
    fetchMock.mockResolvedValue(json({ content: 'x' }))
    await expect(new CodeBuddyWebFetchProvider(sessionOf()).fetch({ url: 'https://example.test/p' }))
      .resolves.toMatchObject({ url: 'https://example.test/p', statusCode: 200, truncated: false })
  })

  it('reports a blocked destination with the seam\'s code', async () => {
    fetchMock.mockResolvedValue(json({ code: 15018, msg: 'forbidden domain: localhost' }, 403))
    await expect(new CodeBuddyWebFetchProvider(sessionOf()).fetch({ url: 'http://localhost:8080/' }))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })
})
