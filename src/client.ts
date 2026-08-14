/**
 * Web client half: a CodeBuddy settings page for in-app OAuth login.
 *
 * Registers one entry in the `settings.section` list — a "CodeBuddy" page that
 * shows the signed-in account, starts the browser login (split across
 * `startLogin` + `pollLogin` on the host auth service), and signs out. The CLI
 * stays as a fallback.
 *
 * Bundled by esbuild into `lib/client.js` (`window.__ModuleLoader__.load`
 * format); externals resolve against the shell's static module table.
 *
 * @module dsh-llm-codebuddy/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { useState, useEffect, useCallback, createElement as h, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** The RPC channel the host auth service listens on (mirror of the host constant). */
const AUTH_CHANNEL = '/codebuddy'

/** The status shape the host `status` endpoint returns. */
interface AuthStatus {
  loggedIn: boolean
  nickname?: string
  uid?: string
  enterpriseId?: string
  enterpriseName?: string
  enterpriseUserName?: string
  departmentFullName?: string
}

/** The startLogin result shape. */
interface LoginStart {
  authUrl: string
  state: string
}

/** The pollLogin result shape. */
interface LoginPoll {
  done: boolean
  nickname?: string
}

/** A successful RPC result. */
interface RpcOk<T> { ok: true, value: T }
/** A failed RPC result. */
interface RpcErr { ok: false, error: { code: string, message: string, details: Record<string, unknown> } }
type RpcResult<T> = RpcOk<T> | RpcErr

/** The connection RPC face injected as `ctx.connection`. */
interface ConnectionRpc {
  call: <T>(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<RpcResult<T>>
}

/** How often the client polls a started login, in ms. */
const POLL_INTERVAL_MS = 1500
/** How long the client keeps polling before giving up, in ms. */
const POLL_DEADLINE_MS = 10 * 60 * 1000

/** UI phase the page cycles through. */
type Phase = 'loading' | 'idle' | 'error'

// Inline styles referencing theme CSS variables, so the section adapts to the
// active theme without shipping or injecting a stylesheet.
const s = {
  section: { display: 'flex', flexDirection: 'column' as const, gap: '12px', padding: '8px 0' },
  title: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  desc: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px', lineHeight: '22px' },
  muted: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px' },
  error: { margin: 0, color: 'var(--dsw-alias-label-danger, #e5484d)', fontSize: '14px' },
  status: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
  rowLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '14px', minWidth: '160px' },
  rowValue: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', flex: 1, wordBreak: 'break-all' as const },
  actions: { display: 'flex', gap: '8px', marginTop: '8px' },
}

/** One rendered status row: label + value. */
function StatusRow({ label, value }: { label: string, value: string }): ReactElement {
  return h('div', { style: s.row },
    h('span', { style: s.rowLabel }, label),
    h('span', { style: s.rowValue }, value),
  )
}

/**
 * Decode CodeBuddy's `departmentFullName`, which is base64-encoded UTF-8.
 * Falls back to the raw value if it is not valid base64.
 */
function decodeDepartment(raw: string): string {
  try {
    const decoded = atob(raw)
    // base64 of UTF-8: the decoded bytes need TextDecoder to handle multibyte.
    return new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0)))
  } catch {
    return raw
  }
}

/** Turn an RPC failure into a readable string. */
function describeError(result: RpcErr): string {
  return `${result.error.code}: ${result.error.message}`
}

/**
 * The CodeBuddy settings section.
 *
 * `rpc` and `t` arrive through the slot's `inject`; the shell owns modal
 * visibility, so no close affordance is needed here.
 */
function CodeBuddySection({ rpc, t }: {
  rpc: ConnectionRpc
  t: Translate
}): ReactElement {
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<AuthStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loginState, setLoginState] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    const result = await rpc.call<AuthStatus>(AUTH_CHANNEL, 'status', {})
    if (result.ok) {
      setStatus(result.value)
      setPhase('idle')
    } else {
      setError(describeError(result))
      setPhase('error')
    }
  }, [rpc])

  // Load status once on mount.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll an in-flight login until it completes or the deadline passes.
  useEffect(() => {
    if (loginState === undefined) return
    const startedAt = Date.now()
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      const result = await rpc.call<LoginPoll>(AUTH_CHANNEL, 'pollLogin', { state: loginState })
      if (stopped) return
      if (result.ok && result.value.done) {
        setLoginState(undefined)
        await refresh()
        return
      }
      if (Date.now() - startedAt >= POLL_DEADLINE_MS) {
        setLoginState(undefined)
        setError(t('timeout'))
        setPhase('error')
        return
      }
      window.setTimeout(tick, POLL_INTERVAL_MS)
    }
    void tick()
    return () => { stopped = true }
  }, [loginState, rpc, refresh])

  const startLogin = useCallback(async () => {
    setError(undefined)
    const result = await rpc.call<LoginStart>(AUTH_CHANNEL, 'startLogin', {})
    if (!result.ok) {
      setError(describeError(result))
      setPhase('error')
      return
    }
    // Open the login page in a new tab; the host polls the handshake.
    window.open(result.value.authUrl, '_blank', 'noopener')
    setLoginState(result.value.state)
  }, [rpc])

  const logout = useCallback(async () => {
    const result = await rpc.call<void>(AUTH_CHANNEL, 'logout', {})
    if (result.ok) {
      setStatus({ loggedIn: false })
    } else {
      setError(describeError(result))
      setPhase('error')
    }
  }, [rpc])

  if (phase === 'loading') {
    return h('div', { style: s.section }, h('p', { style: s.muted }, t('loading')))
  }

  const signedIn = status?.loggedIn === true

  return h('div', { style: s.section },
    h('h2', { style: s.title }, 'CodeBuddy'),
    !signedIn ? h('p', { style: s.desc }, t('desc')) : null,
    error !== undefined ? h('p', { style: s.error }, error) : null,
    signedIn
      ? h('div', { style: s.status },
          h(StatusRow, { label: t('account'), value: status?.nickname ?? '—' }),
          status?.uid !== undefined ? h(StatusRow, { label: t('uid'), value: status.uid }) : null,
          status?.enterpriseName !== undefined
            ? h(StatusRow, { label: t('organization'), value: status.enterpriseName })
            : null,
          status?.enterpriseId !== undefined
            ? h(StatusRow, { label: t('organizationId'), value: status.enterpriseId })
            : null,
          status?.enterpriseUserName !== undefined
            ? h(StatusRow, { label: t('enterpriseUser'), value: status.enterpriseUserName })
            : null,
          status?.departmentFullName !== undefined
            ? h(StatusRow, { label: t('department'), value: decodeDepartment(status.departmentFullName) })
            : null,
          h('div', { style: s.actions },
            h(Button, {
              variant: 'outline',
              size: 'md',
              onClick: () => { void logout() },
            }, t('signOut')),
          ),
        )
      : h('div', { style: s.status },
          h('p', { style: s.muted },
            loginState !== undefined ? t('waiting') : t('notSignedIn'),
          ),
          h('div', { style: s.actions },
            h(Button, {
              variant: 'primary',
              size: 'md',
              disabled: loginState !== undefined,
              onClick: () => { void startLogin() },
            }, loginState !== undefined ? t('signingIn') : t('signIn')),
          ),
        ),
  )
}

/** This plugin's settings namespace for copy. */
const NS = 'settings.codebuddy'

/** Copy dictionaries for every locale the shell ships (zh, en). */
const DICTS = {
  zh: {
    'nav': 'CodeBuddy',
    'desc': '使用腾讯 CodeBuddy 账号登录。',
    'loading': '加载中…',
    'notSignedIn': '未登录。',
    'waiting': '等待浏览器登录完成…',
    'signIn': '登录',
    'signingIn': '登录中…',
    'signOut': '退出登录',
    'timeout': '登录超时，请重试。',
    'account': '账号',
    'uid': 'UID',
    'organization': '公司',
    'organizationId': '公司 ID',
    'enterpriseUser': '企业用户名',
    'department': '部门',
  },
  en: {
    'nav': 'CodeBuddy',
    'desc': 'Sign in with your Tencent CodeBuddy account.',
    'loading': 'Loading…',
    'notSignedIn': 'Not signed in.',
    'waiting': 'Waiting for the browser sign-in to complete…',
    'signIn': 'Sign in',
    'signingIn': 'Signing in…',
    'signOut': 'Sign out',
    'timeout': 'Sign-in timed out. Please try again.',
    'account': 'Account',
    'uid': 'UID',
    'organization': 'Organization',
    'organizationId': 'Organization ID',
    'enterpriseUser': 'Enterprise user',
    'department': 'Department',
  },
}

/** A bound translate function, passed to the section through `inject`. */
type Translate = (key: string, params?: Record<string, string>) => string

export const inject = ['slots', 'locale', 'connection'] as const

/** Register the CodeBuddy section once the `settings.section` slot is declared. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-llm-codebuddy: settings copy')

  const t = ctx.locale.bind(NS)
  const rpc = ctx.connection.rpc as ConnectionRpc
  const injected = () => ({ rpc, t: t as Translate })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codebuddy',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, CodeBuddySection))
}
