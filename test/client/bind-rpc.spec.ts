import { describe, expect, it } from 'vitest'
import { bindCodeBuddyRpc } from '../../src/client/bind.js'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

/** A transport double that records what the binding sends and answers ok. */
function rpcOf(value: unknown = { loggedIn: false }) {
  const sent: { channel: string, endpoint: string, payload: unknown }[] = []
  const rpc = {
    call: async (channel: string, endpoint: string, payload: unknown) => {
      sent.push({ channel, endpoint, payload })
      return { ok: true, value }
    },
  }
  return { sent, rpc: rpc as unknown as ClientConnectionRpc }
}

/** The Gateway accepts a body carrying exactly one plain-object `args` field. */
function isGatewayPayload(payload: unknown): boolean {
  const plain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  return plain(payload)
    && Reflect.ownKeys(payload).length === 1
    && Object.hasOwn(payload, 'args')
    && plain((payload as { args: unknown }).args)
}

describe('bindCodeBuddyRpc', () => {
  it('posts every endpoint to the Gateway channel under this namespace', async () => {
    const { sent, rpc } = rpcOf()
    const bind = bindCodeBuddyRpc(rpc)
    await bind.call('status', {})
    await bind.call('models', {})
    expect(sent.map((s) => `${s.channel}/${s.endpoint}`)).toEqual([
      '/api/codebuddy/status',
      '/api/codebuddy/models',
    ])
  })

  it('wraps every request in the args field the Gateway reads', async () => {
    const { sent, rpc } = rpcOf()
    const bind = bindCodeBuddyRpc(rpc)
    await bind.call('status', {})
    await bind.call('startLogin', { site: 'intl' })
    await bind.call('reportLocale', { tag: 'zh-CN' })
    for (const frame of sent) {
      expect(frame.payload, frame.endpoint).toSatisfy(isGatewayPayload)
    }
  })

  it('carries the request fields inside args, not beside it', async () => {
    const { sent, rpc } = rpcOf()
    await bindCodeBuddyRpc(rpc).call('startLogin', { site: 'cn' })
    expect(sent[0]?.payload).toEqual({ args: { site: 'cn' } })
  })

  it('keeps an endpoint with no parameters a plain empty object', async () => {
    const { sent, rpc } = rpcOf()
    await bindCodeBuddyRpc(rpc).call('logout', {})
    expect(sent[0]?.payload).toEqual({ args: {} })
  })

  it('forwards the abort signal so an abandoned call can be cancelled', async () => {
    const signal = new AbortController().signal
    const seen: (AbortSignal | undefined)[] = []
    const rpc = {
      call: async (_c: string, _e: string, _p: unknown, s?: AbortSignal) => {
        seen.push(s)
        return { ok: true, value: {} }
      },
    } as unknown as ClientConnectionRpc
    await bindCodeBuddyRpc(rpc).call('status', {}, signal)
    expect(seen[0]).toBe(signal)
  })
})
