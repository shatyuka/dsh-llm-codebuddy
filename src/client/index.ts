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
import type { ClientConnectionRpc, ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { useState, useEffect, useCallback, useRef, createElement as h, Fragment, type ChangeEvent, type HTMLAttributes, type ReactElement } from 'react'
import {
  Button,
  Tooltip,
  Menu,
  Input,
  IconChevronDownOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CodeBuddyModelSelect, MODEL_SELECT_CSS } from './model-select.js'
import type { ModelSelectT } from './model-select.js'
import { createUsagePrefs, usePersistentPrefs, useUsagePrefs } from './usage-prefs.js'
import type { UsagePrefs } from './usage-prefs.js'
import {
  creditsToUnit,
  formatDraft,
  formatInUnit,
  unitMinimum,
  unitToCredits,
} from './units.js'
import {
  CODEBUDDY_SETTINGS_NAMESPACE,
  CREDIT_UNITS,
  CUSTOM_LIMIT_MIN,
  DANGER_PCT_MAX,
  DANGER_PCT_MIN,
  isCreditUnit,
} from '../settings.js'
import type { CreditUnit } from '../settings.js'
import { usedPercent } from '../quota.js'
import { CODEBUDDY_AUTH_CHANNEL as AUTH_CHANNEL } from '../protocol.js'
import type { CodeBuddySiteId } from '../constants.js'
import type {
  CodeBuddyAuthStatus as AuthStatus,
  CodeBuddyRpcEndpoint,
  CodeBuddyRpcRequest,
  CodeBuddyRpcResponse,
  CodeBuddyUsageResult as UsageResult,
  CodeBuddyUsageWindow as UsageWindow,
} from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser connection service; its package omits this augmentation to avoid colliding with the Host face. */
    connection: ConnectionHandle
  }
}

/**
 * Login-state change notifier: lets the settings page tell the sidebar usage
 * indicator to re-read after a sign-in or sign-out completes, since the two are
 * independent components and the indicator's polling effect would otherwise
 * wait for its next 60s tick.
 */
const loginChangeListeners = new Set<() => void>()
function emitLoginChange(): void {
  for (const listener of loginChangeListeners) listener()
}
function subscribeLoginChange(listener: () => void): () => void {
  loginChangeListeners.add(listener)
  return () => { loginChangeListeners.delete(listener) }
}

/** Failed RPC result used by the settings error presenter. */
type RpcErr = Extract<ConnectionRpcResult<unknown>, { ok: false }>

/** Typed view over the transport for this plugin's endpoint map. */
interface CodeBuddyRpc {
  call: <K extends CodeBuddyRpcEndpoint>(
    endpoint: K,
    payload: CodeBuddyRpcRequest<K>,
    signal?: AbortSignal,
  ) => Promise<ConnectionRpcResult<CodeBuddyRpcResponse<K>>>
}

/**
 * Bind the shared CodeBuddy endpoint map to Connection's intentionally untyped
 * transport boundary. All callers below are now checked against that map.
 */
function bindCodeBuddyRpc(rpc: ClientConnectionRpc): CodeBuddyRpc {
  return {
    call: <K extends CodeBuddyRpcEndpoint>(endpoint: K, payload: CodeBuddyRpcRequest<K>, signal?: AbortSignal) =>
      rpc.call(AUTH_CHANNEL, endpoint, payload, signal) as Promise<ConnectionRpcResult<CodeBuddyRpcResponse<K>>>,
  }
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
  // Usage indicator: a thin bar above the Settings trigger in the wide column,
  // and a ring in the rail. Both share the danger fill once usage crosses the
  // configured threshold.
  usageWrap: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px', height: '28px', width: '100%', boxSizing: 'border-box' as const },
  usageBar: { position: 'relative' as const, flex: 1, height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' as const },
  usageFill: { position: 'absolute' as const, inset: 0, transformOrigin: 'left', transition: 'width 240ms ease' },
  usagePct: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', minWidth: '34px', textAlign: 'right' as const },
  usageRail: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '36px' },
}

/** One rendered status row: label + value. */
function StatusRow({ label, value }: { label: string, value: string }): ReactElement {
  return h('div', { style: s.row },
    h('span', { style: s.rowLabel }, label),
    h('span', { style: s.rowValue }, value),
  )
}

/**
 * The always-visible first account row, doubling as the disclosure control.
 *
 * Collapsed it shows only the nickname; expanded it reveals the rest of the
 * account facts. With nothing further to disclose it renders as a plain
 * {@link StatusRow}, so a bare nickname carries no affordance that would open
 * an empty panel.
 */
function AccountHeader({ label, value, expandable, open, onToggle }: {
  label: string
  value: string
  expandable: boolean
  open: boolean
  onToggle: () => void
}): ReactElement {
  if (!expandable) return h(StatusRow, { label, value })
  return h('button', {
    type: 'button',
    className: 'cb-accountHeader',
    'aria-expanded': open,
    onClick: onToggle,
  },
    h('span', { style: s.rowLabel }, label),
    h('span', { style: s.rowValue }, value),
    // Owning transform lives in the scoped CSS, so the rotation is a pure
    // style concern and this stays a plain state attribute.
    h('span', { className: 'cb-accountChevron', 'data-open': open ? 'true' : 'false' },
      h(IconChevronDownOutlineMedium)),
  )
}

/**
 * The signed-in account block: the nickname alone until the row is clicked,
 * then every fact the credential discloses.
 *
 * The disclosure state is owned here rather than by {@link CodeBuddySection}
 * so a status refresh (or a sign-in replacing the account) resets it through
 * the `key` the caller sets, and no stale expansion survives a different
 * account.
 */
function AccountInfo({ status, t }: {
  status: AuthStatus
  t: Translate
}): ReactElement {
  const [open, setOpen] = useState<boolean>(false)

  // Detail rows, in disclosure order: personal identity first, then the
  // tenant facts the credential carries.
  const details: ReactElement[] = []
  if (status.uid !== undefined) details.push(h(StatusRow, { key: 'uid', label: t('uid'), value: status.uid }))
  if (status.uin !== undefined) details.push(h(StatusRow, { key: 'uin', label: t('uin'), value: status.uin }))
  if (status.domain !== undefined) details.push(h(StatusRow, { key: 'domain', label: t('domain'), value: status.domain }))
  if (status.enterpriseName !== undefined) {
    details.push(h(StatusRow, { key: 'enterprise', label: t('enterprise'), value: status.enterpriseName }))
  }
  if (status.enterpriseId !== undefined) {
    details.push(h(StatusRow, { key: 'enterpriseId', label: t('enterpriseId'), value: status.enterpriseId }))
  }
  if (status.enterpriseUserName !== undefined) {
    details.push(h(StatusRow, { key: 'enterpriseUser', label: t('enterpriseUser'), value: status.enterpriseUserName }))
  }
  if (status.departmentFullName !== undefined) {
    details.push(h(StatusRow, {
      key: 'department',
      label: t('department'),
      value: decodeDepartment(status.departmentFullName),
    }))
  }

  return h(Fragment, null,
    h(AccountHeader, {
      label: t('nickname'),
      value: status.nickname ?? '—',
      expandable: details.length > 0,
      open,
      onToggle: () => { setOpen((v) => !v) },
    }),
    open ? h(Fragment, null, ...details) : null,
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

/** The symbol a unit renders with; credits carry none, matching the meter's own label. */
function unitSymbol(unit: CreditUnit): string {
  switch (unit) {
    case 'usd': return '$'
    case 'cny': return '¥'
    case 'credit': return ''
  }
}

/** Render one amount in `unit`, symbol included so a figure is never unit-less. */
function amountInUnit(credits: number, unit: CreditUnit): string {
  return `${unitSymbol(unit)}${formatInUnit(credits, unit)}`
}

/** Color for a usage fill, switching to danger once at or above the threshold. */
function usageColor(pct: number | undefined, dangerPct: number): string {
  if (pct === undefined) return 'var(--dsw-alias-brand-primary, #3370ff)'
  return pct >= dangerPct
    ? 'var(--dsw-alias-state-error-primary, #e5484d)'
    : 'var(--dsw-alias-brand-primary, #3370ff)'
}

/**
 * Build the tooltip text: the used/total figures plus an optional reset hint.
 *
 * Both figures are credits from the meter; `unit` only decides how they are
 * rendered, so the ratio the bar shows is identical whichever unit is picked.
 */
function usageTooltip(window: UsageWindow, t: Translate, unit: CreditUnit): string {
  const used = window.used !== undefined ? amountInUnit(window.used, unit) : '—'
  const total = window.limit !== undefined ? amountInUnit(window.limit, unit) : '—'
  // The bubble is `white-space: pre-line`, so a literal newline renders as a
  // line break. The first line names the provider so a glance knows what the
  // allowance belongs to, then the used/total figures, then the reset time.
  const lines = [t('nav'), `${t('usageUsed')}: ${used} / ${total}`]
  if (window.resetsAt !== undefined) lines.push(`${t('usageResets')}: ${window.resetsAt}`)
  return lines.join('\n')
}

/**
 * The usage indicator: a bar with a percentage in the wide column, a ring in
 * the rail, both wrapped in a Tooltip with the exact figures. Signed out, a
 * meter outage, or an unparseable reply all render nothing — the affordance is
 * purely additive.
 */
function UsageIndicator({ rpc, t, wide, prefs }: {
  rpc: CodeBuddyRpc
  t: Translate
  wide: boolean
  prefs: UsagePrefs
}): ReactElement | null {
  const [usage, setUsage] = useState<UsageResult | undefined>(undefined)
  // Shared preference store: a flip in the settings rows lands here directly.
  const { showUsage, customLimit, customLimitUnit, dangerPct } = useUsagePrefs(prefs)

  // Re-read usage immediately when a sign-in or sign-out completes, rather
  // than waiting for the next 60s polling tick.
  useEffect(() => subscribeLoginChange(() => {
    void rpc.call('usage', {}).then((result) => {
      if (result.ok && result.value.loggedIn) setUsage(result.value)
      else setUsage(undefined)
    }).catch(() => { /* a re-read failure just keeps the last snapshot */ })
  }), [rpc])

  useEffect(() => {
    if (!showUsage) return
    let stopped = false
    const read = async (): Promise<void> => {
      if (stopped) return
      const result = await rpc.call('usage', {})
      if (stopped) return
      if (result.ok && result.value.loggedIn) {
        setUsage(result.value)
      } else {
        setUsage(undefined)
      }
    }
    void read()
    // The allowance moves only on generation, so a slow refresh is enough.
    const timer = window.setInterval(read, USAGE_REFRESH_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [rpc, showUsage])

  // The preference gates the whole affordance: hidden stops polling and
  // renders nothing.
  if (!showUsage) return null

  const primary = usage?.primary
  if (primary === undefined || primary.used === undefined || primary.limit === undefined) {
    return null
  }
  // A custom cap overrides the meter's limit. Both figures are credits, so the
  // ratio is unit-independent and only the tooltip's rendering follows `unit`.
  // `??` is deliberate: a zero cap is a real budget, not a missing one.
  const limit = customLimit ?? primary.limit
  const pct = usedPercent(primary.used, limit)
  const derived: UsageWindow = {
    name: primary.name,
    used: primary.used,
    limit,
    usedPercent: pct,
    ...primary.resetsAt === undefined ? {} : { resetsAt: primary.resetsAt },
  }
  const label = usageTooltip(derived, t, customLimitUnit)
  const color = usageColor(derived.usedPercent, dangerPct)

  if (wide) {
    const anchor: ReactElement<HTMLAttributes<HTMLDivElement>> = h('div', { style: s.usageWrap },
      h('div', { style: s.usageBar },
        h('div', { style: { ...s.usageFill, width: `${Math.min(pct, 100)}%`, background: color } }),
      ),
      h('span', { style: s.usagePct }, `${Math.round(pct)}%`),
    )
    return h(Tooltip, { label, side: 'top', delayMs: 300, children: anchor })
  }
  // Rail: a ring whose arc fills with usage, percentage centered inside. The
  // arc circles are rotated -90° about their center so the fill starts at 12
  // o'clock, while the svg stays unrotated so the text renders upright.
  const size = 28
  const stroke = 2.5
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const c = 2 * Math.PI * r
  const dash = (Math.min(pct, 100) / 100) * c
  const arcTransform = `rotate(-90 ${cx} ${cy})`
  const anchor: ReactElement<HTMLAttributes<HTMLDivElement>> = h('div', { style: s.usageRail },
    h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
      h('circle', {
        cx, cy, r,
        fill: 'none',
        stroke: 'var(--dsw-alias-border-l2)',
        strokeWidth: stroke,
      }),
      h('circle', {
        cx, cy, r,
        fill: 'none',
        stroke: color,
        strokeWidth: stroke,
        strokeLinecap: 'round',
        strokeDasharray: `${dash} ${c}`,
        transform: arcTransform,
      }),
      h('text', {
        x: cx,
        y: cy,
        textAnchor: 'middle' as const,
        dominantBaseline: 'central' as const,
        fill: 'var(--dsw-alias-label-primary)',
        fontSize: 8,
        fontWeight: 600,
      }, `${Math.round(pct)}`),
    ),
  )
  return h(Tooltip, { label, side: 'right', delayMs: 300, children: anchor })
}

/** How often the usage indicator refreshes, in ms. */
const USAGE_REFRESH_MS = 60_000

/**
 * The CodeBuddy settings section.
 *
 * `rpc` and `t` arrive through the slot's `inject`; the shell owns modal
 * visibility, so no close affordance is needed here.
 */
function CodeBuddySection({ rpc, t, prefs }: {
  rpc: CodeBuddyRpc
  t: Translate
  prefs: UsagePrefs
}): ReactElement {
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<AuthStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loginState, setLoginState] = useState<string | undefined>(undefined)
  const [loginSite, setLoginSite] = useState<CodeBuddySiteId | undefined>(undefined)
  /** A `startLogin` round trip is in flight; guards against a double start. */
  const starting = useRef<boolean>(false)

  /**
   * Re-read the auth status and apply it.
   *
   * Never rejects: the transport reports a broken request by rejecting, and
   * every caller is a lifecycle step that must reach its own transition.
   * @returns the status that was applied, or undefined when the read failed.
   */
  const refresh = useCallback(async (): Promise<AuthStatus | undefined> => {
    try {
      const result = await rpc.call('status', {})
      if (!result.ok) {
        setError(describeError(result))
        setPhase('error')
        return undefined
      }
      setStatus(result.value)
      setPhase('idle')
      return result.value
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setPhase('error')
      return undefined
    }
  }, [rpc])

  // Load status once on mount.
  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Release one Host handshake, returning the failure text when the Host
   * refused it. Cancelling an unknown or already reaped state is a no-op, so a
   * stale state is not an error.
   */
  const cancelHandshake = useCallback(async (state: string): Promise<string | undefined> => {
    try {
      const result = await rpc.call('cancelLogin', { state })
      return result.ok ? undefined : describeError(result)
    } catch (error) {
      // Reported rather than thrown: both callers must still reach their own
      // state transition.
      return error instanceof Error ? error.message : String(error)
    }
  }, [rpc])

  // Poll an in-flight login until it completes or the deadline passes.
  useEffect(() => {
    if (loginState === undefined) return
    const startedAt = Date.now()
    let stopped = false

    /**
     * Abandon the attempt: release the Host handshake, then report the timeout.
     * The Host polls on its own schedule, so a handshake this page walked away
     * from would otherwise keep running — and could still persist a credential.
     */
    const giveUp = async (): Promise<void> => {
      // Every await precedes clearing `loginState`: that teardown sets
      // `stopped`, so a guard after it would skip the timeout message.
      await cancelHandshake(loginState)
      if (stopped) return
      // The run may have committed its credential just before the abort landed,
      // so re-read the status rather than reporting a timeout for a real login.
      const current = await refresh()
      if (stopped) return
      setLoginState(undefined)
      setLoginSite(undefined)
      if (current?.loggedIn === true) {
        emitLoginChange()
        return
      }
      setError(t('timeout'))
      setPhase('error')
    }

    const tick = async (): Promise<void> => {
      if (stopped) return
      // The transport rejects on a broken request. Swallowing it keeps the loop
      // — and the deadline below — alive, so one bad round trip cannot wedge
      // the page on "Signing in…" with every button disabled.
      let result: Awaited<ReturnType<typeof rpc.call<'pollLogin'>>> | undefined
      try {
        result = await rpc.call('pollLogin', { state: loginState })
      } catch {
        result = undefined
      }
      if (stopped) return
      if (result?.ok === true && result.value.done) {
        setLoginState(undefined)
        setLoginSite(undefined)
        await refresh()
        emitLoginChange()
        return
      }
      if (Date.now() - startedAt >= POLL_DEADLINE_MS) {
        await giveUp()
        return
      }
      window.setTimeout(tick, POLL_INTERVAL_MS)
    }
    void tick()
    // Unmount deliberately does NOT cancel the Host handshake: closing the
    // settings panel while the browser login is still open is a normal way to
    // finish signing in, and the credential is worth keeping. Unmounting stops
    // this page from watching, so the run is left to its own Host-side timeout
    // — only the deadline path above releases it.
    return () => { stopped = true }
  }, [loginState, rpc, refresh, cancelHandshake, t])

  const startLogin = useCallback(async (site: CodeBuddySiteId) => {
    // A guard, not the `disabled` prop: that only takes effect once the state
    // below is committed, so two clicks in the same tick would each start a
    // Host handshake and orphan the first one.
    if (starting.current) return
    starting.current = true
    setError(undefined)
    try {
      let result: Awaited<ReturnType<typeof rpc.call<'startLogin'>>>
      try {
        result = await rpc.call('startLogin', { site })
      } catch (error) {
        // A rejected transport must not become an unhandled rejection that
        // leaves the page looking idle with no sign-in in flight.
        setError(error instanceof Error ? error.message : String(error))
        setPhase('error')
        return
      }
      if (!result.ok) {
        setError(describeError(result))
        setPhase('error')
        return
      }
      // Open the login page in a new tab; the host polls the handshake.
      window.open(result.value.authUrl, '_blank', 'noopener')
      setLoginSite(site)
      setLoginState(result.value.state)
    } finally {
      starting.current = false
    }
  }, [rpc])

  const cancelLogin = useCallback(async () => {
    const state = loginState
    if (state === undefined) return
    const failure = await cancelHandshake(state)
    if (failure !== undefined) {
      setError(failure)
      setPhase('error')
      return
    }
    setLoginState(undefined)
    setLoginSite(undefined)
    // The credential may have landed just before the abort; re-read so a real
    // sign-in is not shown as signed out.
    const current = await refresh()
    // The sidebar indicator polls on its own 60s schedule, so a cancelled
    // attempt that did commit a credential must be announced — otherwise a real
    // sign-in would not reach the usage bar until that next tick.
    if (current?.loggedIn === true) emitLoginChange()
  }, [cancelHandshake, loginState, refresh])

  const logout = useCallback(async () => {
    let result: Awaited<ReturnType<typeof rpc.call<'logout'>>>
    try {
      result = await rpc.call('logout', {})
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setPhase('error')
      return
    }
    if (result.ok) {
      setStatus({ loggedIn: false })
      emitLoginChange()
    } else {
      setError(describeError(result))
      setPhase('error')
    }
  }, [rpc])

  if (phase === 'loading') {
    return h('div', { style: s.section }, h('p', { style: s.muted }, t('loading')))
  }

  const signedIn = status?.loggedIn === true
  // A signed-in status always carries the account fields; the fallback only
  // settles the type for the branch below.
  const account: AuthStatus = status ?? { loggedIn: true }

  // The usage preferences live in the Host settings document, so they are
  // configurable whether or not an account is signed in.
  const usagePrefs = h(UsagePrefRows, { t, prefs })

  return h('div', { style: s.section },
    h('h2', { style: s.title }, 'CodeBuddy'),
    error !== undefined ? h('p', { style: s.error }, error) : null,
    signedIn
      ? h('div', { style: s.status },
          h(AccountInfo, {
            // Keyed by the account so replacing it (a new sign-in) starts
            // collapsed rather than inheriting the previous account's state.
            key: account.uid ?? '',
            status: account,
            t,
          }),
          h('div', { style: s.actions },
            h(Button, {
              variant: 'outline',
              size: 'md',
              onClick: () => { void logout() },
            }, t('signOut')),
          ),
          usagePrefs,
        )
      : h('div', { style: s.status },
          h('p', { style: s.desc }, t('intro')),
          h('p', { style: s.muted },
            // Expired names the remedy; a bare "not signed in" would hide
            // that a sign-in is what is missing.
            loginState !== undefined ? t('waiting')
              : status?.expired === true ? t('expired')
                : t('notSignedIn'),
          ),
          // Separate accounts per host: the site must be chosen, not inferred.
          h('div', { style: s.actions },
            SIGN_IN_SITES.map(site => h(Button, {
              key: site,
              variant: 'primary',
              size: 'md',
              disabled: loginState !== undefined,
              onClick: () => { void startLogin(site) },
            }, loginSite === site
              ? t('signingIn')
              : t(site === 'intl' ? 'signInIntl' : 'signInCn'))),
            loginState !== undefined ? h(Button, {
              variant: 'outline',
              size: 'md',
              onClick: () => { void cancelLogin() },
            }, t('cancel')) : null,
          ),
          usagePrefs,
        ),
  )
}

/** The sites offered as sign-in buttons, in display order. */
const SIGN_IN_SITES = ['cn', 'intl'] as const satisfies readonly CodeBuddySiteId[]

/**
 * Format a persisted cap for its input field, expressed in `unit`; an unset
 * cap reads as empty ("use the meter's limit").
 */
function formatLimit(value: number | undefined, unit: CreditUnit): string {
  return value === undefined ? '' : formatDraft(creditsToUnit(value, unit), unit)
}

/**
 * The usage-preference rows. Self-contained: they read the shared store and
 * keep their own drafts, so a keystroke re-renders this component only, and
 * each draft re-syncs only when its own persisted value moves.
 */
function UsagePrefRows({ t, prefs }: {
  t: Translate
  prefs: UsagePrefs
}): ReactElement {
  const { showUsage, customLimit, customLimitUnit, dangerPct } = useUsagePrefs(prefs)
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [unitMenuOpen, setUnitMenuOpen] = useState<boolean>(false)
  // The draft is text in the SELECTED unit; the store's `customLimit` is always
  // credits, so every read converts out and every write converts back.
  const [limitText, setLimitText] = useState<string>(() => formatLimit(customLimit, customLimitUnit))
  const [dangerText, setDangerText] = useState<string>(() => String(dangerPct))
  // Own subscription: the flag flips on scope snapshots, not value changes.
  const persistent = usePersistentPrefs(prefs)

  // The unit is a dependency too: switching units re-renders the SAME cap, so
  // the field must be reformatted rather than left holding the old figure.
  useEffect(() => {
    setLimitText(formatLimit(customLimit, customLimitUnit))
  }, [customLimit, customLimitUnit])
  useEffect(() => { setDangerText(String(dangerPct)) }, [dangerPct])

  const unitLabel = (unit: CreditUnit): string => t(unit === 'credit'
    ? 'unitCredit'
    : unit === 'cny' ? 'unitCny' : 'unitUsd')

  return h(Fragment, null,
    // Non-loopback Host: the settings transport stays process-local, so edits
    // live only in this tab.
    !persistent
      ? h('p', { className: 'cb-prefNotice' }, t('notPersistedNotice'))
      : null,
    // Show/hide the usage indicator: a Menu dropdown so the control matches
    // the General-section selector affordance (no Switch ships with shell).
    h('div', { className: 'cb-prefRow' },
      h('div', { className: 'cb-prefRowText' },
        h('div', { className: 'cb-prefTitle' }, t('showUsage')),
        h('div', { className: 'cb-prefDesc' }, t('showUsageDesc')),
      ),
      h(Menu, {
        open: menuOpen,
        onClose: () => { setMenuOpen(false) },
        items: [
          { id: '1', label: t('on') },
          { id: '0', label: t('off') },
        ],
        selectedId: showUsage ? '1' : '0',
        onSelect: (id: string) => {
          setMenuOpen(false)
          prefs.setShowUsage(id === '1')
        },
        align: 'end',
        portal: true,
        anchor: h('button', {
          type: 'button',
          className: 'cb-prefSelector',
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          onClick: () => { setMenuOpen((v) => !v) },
        }, showUsage ? t('on') : t('off'),
          h(IconChevronDownOutlineMedium),
        ),
      }),
    ),
    // Custom quota cap: overrides the meter's reported limit. The amount is
    // typed in the selected unit and converted to credits here, the only unit
    // the Host stores. Empty clears it, re-inheriting the meter's own total.
    h('div', { className: 'cb-prefRow' },
      h('div', { className: 'cb-prefRowText' },
        h('div', { className: 'cb-prefTitle' }, t('customLimit')),
        h('div', { className: 'cb-prefDesc' }, t('customLimitDesc')),
      ),
      h('div', { className: 'cb-prefControl' },
        h(Input, {
          type: 'number',
          inputMode: 'decimal',
          // The bound follows the unit. The credit floor is zero, so the
          // currency floor is zero too — only a negative amount is refused.
          min: unitMinimum(customLimitUnit, CUSTOM_LIMIT_MIN),
          // A credit cap need not be whole: one entered as a currency is stored
          // at four-decimal credit precision (¥10 is 142.8571), which a fixed
          // step would flag as invalid. `any` still steps by one on arrow keys.
          step: customLimitUnit === 'credit' ? 'any' : 0.01,
          placeholder: t('customLimitPlaceholder'),
          className: 'cb-prefInput',
          value: limitText,
          onChange: (e: ChangeEvent<HTMLInputElement>) => { setLimitText(e.currentTarget.value) },
          onBlur: () => {
            // Compare TEXT, not a re-parsed figure: the currency view is lossy
            // (¥10 is 142.8571 credits, shown as $1.43), so reading the rounded
            // text back would drift the stored budget on every focus/blur or
            // unit switch. An unchanged field means there was no edit.
            const shown = formatLimit(customLimit, customLimitUnit)
            if (limitText === shown) return
            const parsed = Number(limitText)
            // Empty means "follow the meter"; anything else is judged as its
            // CREDIT equivalent. Zero is a real budget and is kept.
            const credits = limitText.length === 0 || !Number.isFinite(parsed)
              ? undefined
              : unitToCredits(parsed, customLimitUnit)
            if (credits === undefined || credits < CUSTOM_LIMIT_MIN) {
              prefs.setCustomLimit(undefined)
              // A no-op publish never fires the adoption subscription, so the
              // draft is reset directly.
              setLimitText(formatLimit(undefined, customLimitUnit))
              return
            }
            prefs.setCustomLimit(credits)
            // Echo what the Host will hold, so a currency draft does not keep
            // more precision than was actually stored.
            setLimitText(formatLimit(credits, customLimitUnit))
          },
        }),
        // Unit selector: the same dropdown affordance as the row above.
        h(Menu, {
          open: unitMenuOpen,
          onClose: () => { setUnitMenuOpen(false) },
          items: CREDIT_UNITS.map(unit => ({ id: unit, label: unitLabel(unit) })),
          selectedId: customLimitUnit,
          onSelect: (id: string) => {
            setUnitMenuOpen(false)
            // The store only accepts the closed unit set, so an id that is not
            // one of them (impossible from this list) is simply ignored.
            if (isCreditUnit(id)) prefs.setCustomLimitUnit(id)
          },
          align: 'end',
          portal: true,
          anchor: h('button', {
            type: 'button',
            className: 'cb-prefSelector',
            'aria-haspopup': 'menu',
            'aria-expanded': unitMenuOpen,
            'aria-label': t('customLimitUnit'),
            onClick: () => { setUnitMenuOpen((v) => !v) },
          }, unitLabel(customLimitUnit),
            h(IconChevronDownOutlineMedium),
          ),
        }),
      ),
    ),
    // Danger threshold: above this used-percentage the fill turns red.
    h('div', { className: 'cb-prefRow' },
      h('div', { className: 'cb-prefRowText' },
        h('div', { className: 'cb-prefTitle' }, t('dangerPct')),
        h('div', { className: 'cb-prefDesc' }, t('dangerPctDesc')),
      ),
      h(Input, {
        type: 'number',
        inputMode: 'numeric',
        min: DANGER_PCT_MIN,
        max: DANGER_PCT_MAX,
        step: 1,
        className: 'cb-prefInput',
        value: dangerText,
        onChange: (e: ChangeEvent<HTMLInputElement>) => { setDangerText(e.currentTarget.value) },
        onBlur: () => {
          const parsed = Number(dangerText)
          if (!Number.isFinite(parsed) || parsed < DANGER_PCT_MIN || parsed > DANGER_PCT_MAX) {
            // Clear rather than store a value the schema would refuse.
            prefs.setDangerPct(undefined)
            setDangerText(String(dangerPct))
          } else {
            prefs.setDangerPct(Math.round(parsed))
          }
        },
      }),
    ),
  )
}

/** This plugin's settings namespace for copy. */
const NS = 'settings.codebuddy'

/** Copy dictionaries for every locale the shell ships (zh, en). */
const DICTS = {
  zh: {
    'nav': 'CodeBuddy',
    'intro': '使用腾讯 CodeBuddy 账号登录。',
    'loading': '加载中…',
    'notSignedIn': '未登录。',
    'expired': '登录已过期，请重新登录。',
    'waiting': '等待浏览器登录完成…',
    'signInCn': '登录中国站',
    'signInIntl': '登录国际站',
    'signingIn': '登录中…',
    'cancel': '取消',
    'signOut': '退出登录',
    'timeout': '登录超时，请重试。',
    'nickname': '昵称',
    'uid': 'UID',
    'uin': 'UIN',
    'domain': '域名',
    'enterprise': '企业',
    'enterpriseId': '企业 ID',
    'enterpriseUser': '企业用户名',
    'department': '部门',
    'showUsage': '显示额度余量',
    'showUsageDesc': '在侧边栏底部设置按钮上方显示已用额度进度。',
    'notPersistedNotice': '当前连接不持久保存偏好：在此处的修改仅对本次会话生效。',
    'on': '开',
    'off': '关',
    'customLimit': '自定义额度上限',
    'customLimitDesc': '覆盖服务端上报的总量，按此值计算已用百分比。留空则使用服务端总量。',
    'customLimitPlaceholder': '使用默认',
    'customLimitUnit': '额度单位',
    'unitCredit': '积分',
    'unitCny': '人民币',
    'unitUsd': '美元',
    'dangerPct': '余量告警百分比',
    'dangerPctDesc': '已用百分比达到此值时，进度条变为红色提醒。默认 90%。',
    'usageUsed': '已用额度',
    'usageResets': '重置时间',
  },
  en: {
    'nav': 'CodeBuddy',
    'intro': 'Sign in with your Tencent CodeBuddy account.',
    'loading': 'Loading…',
    'notSignedIn': 'Not signed in.',
    'expired': 'Your session has expired. Please sign in again.',
    'waiting': 'Waiting for the browser sign-in to complete…',
    'signInCn': 'Sign in (China)',
    'signInIntl': 'Sign in (Intl)',
    'signingIn': 'Signing in…',
    'cancel': 'Cancel',
    'signOut': 'Sign out',
    'timeout': 'Sign-in timed out. Please try again.',
    'nickname': 'Nickname',
    'uid': 'UID',
    'uin': 'UIN',
    'domain': 'Domain',
    'enterprise': 'Enterprise',
    'enterpriseId': 'Enterprise ID',
    'enterpriseUser': 'Enterprise user',
    'department': 'Department',
    'showUsage': 'Show usage allowance',
    'showUsageDesc': 'Display the used-allowance progress above the Settings button at the sidebar foot.',
    'notPersistedNotice': 'Preferences are not persisted over this connection: changes here last only for this session.',
    'on': 'On',
    'off': 'Off',
    'customLimit': 'Custom quota cap',
    'customLimitDesc': 'Overrides the server-reported limit when computing the used percentage. Leave empty to use the server value.',
    'customLimitPlaceholder': 'Default',
    'customLimitUnit': 'Quota unit',
    'unitCredit': 'Credits',
    'unitCny': 'CNY',
    'unitUsd': 'USD',
    'dangerPct': 'Low-allowance alert',
    'dangerPctDesc': 'The fill turns red once used usage reaches this percentage. Defaults to 90%.',
    'usageUsed': 'Usage',
    'usageResets': 'Resets at',
  },
} as const

type CodeBuddyLocaleKey = keyof typeof DICTS.en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the CodeBuddy settings page and sidebar usage indicator. */
    'settings.codebuddy': CodeBuddyLocaleKey
  }
}

/** A bound translate function, passed to the section through `inject`. */
type Translate = TranslateNS<typeof NS>

/**
 * Module-level service declarations. Beyond this plugin's own seats, the
 * model-selector shadow declares the ModelDirectoryResolver's dependency
 * closure: the service forwards method calls with the CALLER's context as
 * receiver, so `directoryFor` reads `sessions` / `remote` / `remote.session`
 * through this inject declaration.
 */
export const inject = [
  'slots',
  'locale',
  'connection',
  'configForms',
  'modelDirectories',
  'sessions',
  'remote',
  'remote.session',
] as const

/**
 * Scoped CSS for the settings rows: inline styles cannot express the `:hover`
 * and focus pseudo-states the shipped rows use, so one `<style>` tag carries
 * them under plugin-scoped classes.
 */
const PREF_CSS = `
.cb-prefRow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.cb-prefRowText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;padding-right:48px}
.cb-prefNotice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.cb-prefTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.cb-prefDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.cb-prefSelector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;flex:none}
.cb-prefSelector:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cb-prefSelector:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cb-prefInput{width:120px}
.cb-prefControl{display:flex;align-items:center;gap:8px;flex:none}
.cb-accountHeader{display:flex;align-items:center;gap:12px;width:100%;padding:8px 0;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);background:none;font:inherit;text-align:left;cursor:pointer}
.cb-accountHeader:hover .cb-accountChevron{color:var(--dsw-alias-label-secondary)}
.cb-accountHeader:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}
.cb-accountChevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 160ms ease,color 160ms ease}
.cb-accountChevron[data-open="true"]{transform:rotate(180deg)}
`
const PREF_CSS_TAG = '@shatyuka/dsh-llm-codebuddy/pref.module.css'

function injectPrefCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(PREF_CSS_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@shatyuka/dsh-llm-codebuddy'
  tag.dataset.pluginCss = PREF_CSS_TAG
  tag.textContent = PREF_CSS
  document.head.appendChild(tag)
}

/** Register the CodeBuddy section once the `settings.section` slot is declared. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-llm-codebuddy: settings copy')
  injectPrefCss()
  injectModelSelectCss()

  const rpc = bindCodeBuddyRpc(ctx.connection.rpc)
  const t = ctx.locale.bind(NS)

  // Durable preferences: this plugin's own configuration form. When the
  // settings transport reports the entry `unavailable` the surface keeps the
  // schema defaults, so the controls stay usable.
  const prefs = createUsagePrefs(ctx.configForms.get(CODEBUDDY_SETTINGS_NAMESPACE))
  ctx.effect(() => () => { prefs.dispose() }, 'dsh-llm-codebuddy: settings form subscription')

  const injected = () => ({ rpc, prefs })

  // Only a real locale change is worth a request; subscribers also fire for
  // dictionary registrations.
  ctx.effect(() => {
    const locale = ctx.locale
    let last: string | undefined
    const report = (): void => {
      const active = locale.getSnapshot?.()?.active
      if (active === undefined || active === last) return
      last = active
      void Promise.resolve(rpc.call('locale', active)).catch(() => {})
    }
    report()
    return locale.subscribe?.(report) ?? (() => {})
  }, 'dsh-llm-codebuddy: language reporting')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'codebuddy',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, CodeBuddySection))

  // A usage indicator above the Settings trigger; renders nothing while signed
  // out or while the meter plane is unreachable.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'codebuddy-usage',
    order: 10,
    locale: NS,
    inject: injected,
  }, UsageIndicator))

  // The CodeBuddy-flavoured composer model seat, shadowing
  // `conversation.input.model` at a lower priority value. Selection state stays
  // shared: the injected face resolves the SAME per-session ModelDirectory the
  // official seat and the /model popup read, so picking here updates both.
  ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'], (scope) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    const enrichedRpc = {
      models: async () => {
        const result = await rpc.call('models', {})
        return result.ok && result.value.loggedIn ? result.value.models : undefined
      },
    }
    // Copy comes from the official `model` namespace, keeping the shell's own
    // wording (and any future key changes) for free.
    const modelT: ModelSelectT = ctx.locale.bind('model')
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      // Shadowing requires a lower priority than the shipped default 0.
      priority: -1,
      inject: (sessionId) => {
        const directory = models.directoryFor(sessionId)
        return {
          available: sessions.subagentAddress(sessionId) === undefined,
          directory: directory.store,
          load: () => { directory.load().catch(() => {}) },
          select: (selection: { provider: string, model: string, reasoningEffort?: string }) =>
            directory.select(selection),
        }
      },
    }, (props: Omit<Parameters<typeof CodeBuddyModelSelect>[0], 'rpc' | 't'>) => CodeBuddyModelSelect({
      ...props,
      rpc: enrichedRpc,
      t: modelT,
    })))
  })
}

/** Inject the model seat's stylesheet once per document. */
function injectModelSelectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="@shatyuka/dsh-llm-codebuddy/model-select.module.css"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@shatyuka/dsh-llm-codebuddy'
  tag.dataset.pluginCss = '@shatyuka/dsh-llm-codebuddy/model-select.module.css'
  tag.textContent = MODEL_SELECT_CSS
  document.head.appendChild(tag)
}
