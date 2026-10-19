import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, inject, name, resolveConnectionOptions } from '../src/index.js'
import { saveStorage } from '../src/storage.js'
import {
  CODEBUDDY_PROVIDER,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '../src/constants.js'
import type { CodeBuddyStorage } from '../src/storage.js'

describe('plugin identity', () => {
  it('names itself and declares the service it needs', () => {
    expect(name).toBe('llm-codebuddy')
    expect(inject).toEqual(['llm'])
  })

  it('exposes a config schema every field of which is optional', () => {
    // A bare row in cordis.patch.yml must reach the public service, so no
    // route fact may be required.
    expect(() => Config({})).not.toThrow()
    const resolved = Config({}) as Record<string, unknown>
    for (const field of ['baseURL', 'defaultContextWindow', 'defaultMaxTokens', 'streamIdleTimeoutMs', 'retryPolicy']) {
      expect(resolved[field], field).toBeUndefined()
    }
  })

  it('rejects an out-of-range retry policy at load', () => {
    expect(() => Config({ retryPolicy: { mode: 'forever' } as never })).toThrow(/retryPolicy/u)
  })

  it('accepts the preference fields the settings page writes', () => {
    expect(() => Config({
      showUsage: false,
      customLimit: 0,
      customLimitUnit: 'cny',
      dangerPct: 80,
      modelOrder: ['a'],
      hiddenModels: ['b'],
    })).not.toThrow()
  })
})

describe('resolveConnectionOptions', () => {
  it('fills every default for an empty config', () => {
    const options = resolveConnectionOptions({})
    expect(options).toMatchObject({
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    })
    expect(options).not.toHaveProperty('baseURL')
  })

  it('resolves the harness default retry policy when none was configured', () => {
    expect(resolveConnectionOptions({}).retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 5 })
  })

  it('carries explicit values through', () => {
    expect(resolveConnectionOptions({
      defaultContextWindow: 200_000,
      defaultMaxTokens: 16_000,
      streamIdleTimeoutMs: 60_000,
      baseURL: 'https://proxy.example/v2',
    })).toMatchObject({
      defaultContextWindow: 200_000,
      defaultMaxTokens: 16_000,
      streamIdleTimeoutMs: 60_000,
      baseURL: 'https://proxy.example/v2',
    })
  })

  it('strips the trailing slash from a base override', () => {
    // `https://host/v2//chat/completions` is routed differently by some
    // gateways, so the override is normalized once at load.
    expect(resolveConnectionOptions({ baseURL: 'https://proxy.example/v2//' }).baseURL)
      .toBe('https://proxy.example/v2')
  })

  it('rejects an empty base override', () => {
    expect(() => resolveConnectionOptions({ baseURL: '' })).toThrow(/baseURL must not be empty/u)
  })

  it('requires positive integers for the sizing fields', () => {
    for (const field of ['defaultContextWindow', 'defaultMaxTokens'] as const) {
      for (const value of [0, -1, 1.5, Number.NaN]) {
        expect(() => resolveConnectionOptions({ [field]: value }), `${field}=${String(value)}`)
          .toThrow(new RegExp(`${field} must be a positive integer`, 'u'))
      }
    }
  })

  it('requires a positive finite idle timeout', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveConnectionOptions({ streamIdleTimeoutMs: value }))
        .toThrow(/streamIdleTimeoutMs must be a positive finite number/u)
    }
  })

  it('forwards a configured retry policy to the harness resolver', () => {
    // `mode` is required by the harness resolver, so a caller overriding one
    // bound must name the mode too; this asserts the value reaches it intact.
    const options = resolveConnectionOptions({ retryPolicy: { mode: 'normal', maxRetries: 2 } })
    expect(options.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 2 })
  })

  it('names the field when a policy is refused', () => {
    expect(() => resolveConnectionOptions({ retryPolicy: { mode: 'normal', backoff: { jitterRatio: 2 } } }))
      .toThrow(/dsh-llm-codebuddy: retryPolicy/u)
  })
})

describe('apply', () => {
  let home: string
  let credentialPath: string

  /** A context double recording registrations, effects, and log lines. */
  function contextOf() {
    const registered: { providers: readonly string[], adapter: unknown }[] = []
    const effects: string[] = []
    const emitted: string[] = []
    return {
      registered,
      effects,
      emitted,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      llm: {
        registerAdapter: (providers: readonly string[], adapter: unknown) => {
          registered.push({ providers, adapter })
          return () => {}
        },
      },
      get: (_name: string): unknown => undefined,
      emit: (event: string) => { emitted.push(event) },
      effect: (fn: () => unknown, label?: string) => {
        effects.push(label ?? '')
        return fn()
      },
      // The auth service registers itself through this; the route surface is
      // covered by its own suite.
      inject: (_deps: readonly string[], _fn: (scope: unknown) => void) => undefined,
    }
  }

  /** A stored credential, so the mount sees a signed-in harness. */
  function credential(): CodeBuddyStorage {
    return {
      site: 'cn',
      auth: {
        accessToken: 'a',
        expiresAt: Date.now() + 3_600_000,
        refreshToken: 'r',
        refreshExpiresAt: Date.now() + 7_200_000,
        domain: 'corp.example',
      },
      account: { uid: 'u', nickname: 'Nick' },
    }
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'codebuddy-index-'))
    credentialPath = join(home, 'codebuddy-auth.json')
    process.env['DSH_CODEBUDDY_AUTH_FILE'] = credentialPath
  })

  afterEach(async () => {
    delete process.env['DSH_CODEBUDDY_AUTH_FILE']
    await rm(home, { recursive: true, force: true })
  })

  it('registers exactly one adapter under the codebuddy route', () => {
    const ctx = contextOf()
    apply(ctx as never)
    expect(ctx.registered).toHaveLength(1)
    expect(ctx.registered[0]?.providers).toEqual([CODEBUDDY_PROVIDER])
  })

  /** The option thunk the mount handed the adapter. */
  function mountedTurnOf(ctx: ReturnType<typeof contextOf>) {
    return (ctx.registered[0]!.adapter as { config: { turnOf?: () => ((id: string) => number | undefined) | undefined } })
      .config.turnOf
  }

  it('wires a turn reader that reads the host registries', () => {
    const ctx = {
      ...contextOf(),
      get: (name: string) => name === 'sessions'
        ? { get: () => ({ id: 'sess-1' }) }
        : name === 'sessionProjections' ? { stateOf: () => ({ lastTurn: 4 }) } : undefined,
    }
    apply(ctx as never)
    expect(mountedTurnOf(ctx)?.()?.('sess-1')).toBe(4)
  })

  it('wires a turn reader that degrades without the registries', () => {
    const ctx = contextOf()
    apply(ctx as never)
    // Absent services leave the reader undefined rather than failing the mount.
    expect(mountedTurnOf(ctx)?.()).toBeUndefined()
  })

  it('fails at load on a bad config rather than mid-request', () => {
    expect(() => apply(contextOf() as never, { defaultMaxTokens: -1 })).toThrow(/defaultMaxTokens/u)
  })

  it('installs the catalog-announcement and polling effects', () => {
    const ctx = contextOf()
    apply(ctx as never)
    expect(ctx.effects.some(label => label.includes('catalog change announcements'))).toBe(true)
    expect(ctx.effects.some(label => label.includes('catalog change polling'))).toBe(true)
  })

  it('reports a missing credential once at mount, without failing it', async () => {
    const ctx = contextOf()
    apply(ctx as never)
    await vi.waitFor(() => expect(ctx.logger.info).toHaveBeenCalled())
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('Settings'))
    expect(ctx.logger.error).not.toHaveBeenCalled()
  })

  it('stays quiet when the harness already holds a credential', async () => {
    await saveStorage(credential())
    const ctx = contextOf()
    apply(ctx as never)
    // Wait for the mount's advisory read to settle, then confirm it said nothing.
    await vi.waitFor(async () => {
      expect(ctx.logger.info).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  })
})
