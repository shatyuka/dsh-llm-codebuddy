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
import { useState, useEffect, useCallback, createElement as h, Fragment, type ChangeEvent, type ReactElement } from 'react'
import {
  Button,
  Tooltip,
  Menu,
  Input,
  IconChevronDownOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** The RPC channel the host auth service listens on (mirror of the host constant). */
const AUTH_CHANNEL = '/codebuddy'

/**
 * Local usage-indicator preferences: whether it shows, and an optional custom
 * quota cap that overrides the meter's reported limit.
 *
 * Both are UI-only affordances with no business meaning beyond this surface,
 * so they live in `localStorage` rather than the Host user-settings document a
 * feature plugin would adopt. The store is module-scoped so the settings page
 * controls and the sidebar indicator share one source of truth, and `storage`
 * events keep other tabs in sync without a Host round-trip.
 */
const USAGE_PREF_KEY = 'dsh-codebuddy:show-usage'
const CUSTOM_LIMIT_KEY = 'dsh-codebuddy:custom-limit'
const DANGER_PCT_KEY = 'dsh-codebuddy:danger-pct'
const usagePrefListeners = new Set<() => void>()

/** Read the persisted show/hide preference; defaults to shown when unset/unreadable. */
function getUsagePref(): boolean {
  try {
    return window.localStorage.getItem(USAGE_PREF_KEY) !== '0'
  } catch {
    return true
  }
}

/** Persist the show/hide preference and notify every subscriber in every tab. */
function setUsagePref(value: boolean): void {
  try {
    window.localStorage.setItem(USAGE_PREF_KEY, value ? '1' : '0')
  } catch {
    // A private-mode storage refusal still updates the in-memory listeners, so
    // the toggle stays responsive for the lifetime of this tab.
  }
  emitUsagePref()
}

/**
 * Read the custom quota cap; `undefined` when unset or not a positive number.
 *
 * The cap overrides the meter's reported `limit` so `usedPercent` and the
 * tooltip reflect a budget the user cares about rather than the provider's
 * billing cycle. An empty/invalid value means "use the server's limit".
 */
function getCustomLimit(): number | undefined {
  try {
    const raw = window.localStorage.getItem(CUSTOM_LIMIT_KEY)
    if (raw === null) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Persist the custom quota cap and notify subscribers. */
function setCustomLimit(value: number | undefined): void {
  try {
    if (value === undefined) {
      window.localStorage.removeItem(CUSTOM_LIMIT_KEY)
    } else {
      window.localStorage.setItem(CUSTOM_LIMIT_KEY, String(value))
    }
  } catch {
    // See setUsagePref: an in-memory update still reaches this tab's listeners.
  }
  emitUsagePref()
}

/**
 * Read the danger-percentage threshold; defaults to 90 when unset/invalid.
 *
 * Above this used-percentage the indicator fill turns the error color, so the
 * user can spot an allowance that is about to run out without watching the
 * exact number.
 */
const DEFAULT_DANGER_PCT = 90
function getDangerPct(): number {
  try {
    const raw = window.localStorage.getItem(DANGER_PCT_KEY)
    if (raw === null) return DEFAULT_DANGER_PCT
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : DEFAULT_DANGER_PCT
  } catch {
    return DEFAULT_DANGER_PCT
  }
}

/** Persist the danger-percentage threshold and notify subscribers. */
function setDangerPct(value: number | undefined): void {
  try {
    if (value === undefined) {
      window.localStorage.removeItem(DANGER_PCT_KEY)
    } else {
      window.localStorage.setItem(DANGER_PCT_KEY, String(value))
    }
  } catch {
    // See setUsagePref: an in-memory update still reaches this tab's listeners.
  }
  emitUsagePref()
}

/** Subscribe to preference changes; returns the disposer. */
function subscribeUsagePref(listener: () => void): () => void {
  usagePrefListeners.add(listener)
  return () => { usagePrefListeners.delete(listener) }
}

function emitUsagePref(): void {
  for (const listener of usagePrefListeners) listener()
}

// Cross-tab sync: a `storage` event fires in every *other* tab when any key
// changes, so each tab's indicator and controls re-read without a Host call.
if (typeof window !== 'undefined' && window.localStorage !== undefined) {
  window.addEventListener('storage', (event) => {
    if (event.key === USAGE_PREF_KEY || event.key === CUSTOM_LIMIT_KEY
      || event.key === DANGER_PCT_KEY || event.key === null) {
      emitUsagePref()
    }
  })
}

/** The status shape the host `status` endpoint returns. */
interface AuthStatus {
  loggedIn: boolean
  nickname?: string
  uid?: string
  uin?: string
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

/** One metering window the host `usage` endpoint reports. */
interface UsageWindow {
  name: string
  used?: number
  limit?: number
  usedPercent?: number
  resetsAt?: string
}

/** The usage result shape the host `usage` endpoint returns. */
interface UsageResult {
  loggedIn: boolean
  windows: UsageWindow[]
  primary?: UsageWindow
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

/** Format a usage figure with up to one decimal place and thousands separators. */
function formatAmount(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

/** Color for a usage fill, switching to danger once at or above the threshold. */
function usageColor(pct: number | undefined, dangerPct: number): string {
  if (pct === undefined) return 'var(--dsw-alias-brand-primary, #3370ff)'
  return pct >= dangerPct
    ? 'var(--dsw-alias-state-error-primary, #e5484d)'
    : 'var(--dsw-alias-brand-primary, #3370ff)'
}

/** Build the tooltip text: the used/total figures plus an optional reset hint. */
function usageTooltip(window: UsageWindow, t: Translate): string {
  const used = window.used !== undefined ? formatAmount(window.used) : '—'
  const total = window.limit !== undefined ? formatAmount(window.limit) : '—'
  // The bubble is `white-space: pre-line`, so a literal newline renders as a
  // line break. The first line names the provider so a glance knows what the
  // allowance belongs to, then the used/total figures, then the reset time.
  const lines = [t('nav'), `${t('usageUsed')}: ${used} / ${total}`]
  if (window.resetsAt !== undefined) lines.push(`${t('usageResets')}: ${window.resetsAt}`)
  return lines.join('\n')
}

/**
 * The usage indicator rendered above the Settings trigger in the sidebar foot.
 *
 * Polls the host `usage` endpoint while signed in, then renders a horizontal
 * bar with a percentage in the wide column and a ring in the rail. Both are
 * wrapped in a {@link Tooltip} that surfaces the exact used/total figures on
 * hover. A signed-out account, a meter outage, or an unparseable reply all
 * render nothing — the affordance is purely additive.
 * @param rpc - the connection RPC face.
 * @param t - the bound translate function.
 * @param wide - whether the sidebar renders wide content.
 */
function UsageIndicator({ rpc, t, wide }: {
  rpc: ConnectionRpc
  t: Translate
  wide: boolean
}): ReactElement | null {
  const [usage, setUsage] = useState<UsageResult | undefined>(undefined)
  const [showUsage, setShowUsage] = useState<boolean>(getUsagePref())
  const [customLimit, setCustomLimitState] = useState<number | undefined>(getCustomLimit())
  const [dangerPct, setDangerPctState] = useState<number>(getDangerPct())

  // Re-render when the preference flips from the settings controls (same tab)
  // or a `storage` event (other tab); the polling effect below reads the
  // latest value, so a disabled indicator stops fetching on the next tick.
  useEffect(() => subscribeUsagePref(() => {
    setShowUsage(getUsagePref())
    setCustomLimitState(getCustomLimit())
    setDangerPctState(getDangerPct())
  }), [])

  useEffect(() => {
    if (!showUsage) return
    let stopped = false
    const read = async (): Promise<void> => {
      if (stopped) return
      const result = await rpc.call<UsageResult>(AUTH_CHANNEL, 'usage', {})
      if (stopped) return
      if (result.ok && result.value.loggedIn) {
        setUsage(result.value)
      } else {
        setUsage(undefined)
      }
    }
    void read()
    // The allowance moves only on generation, so a slow refresh is enough to
    // stay current without hammering the meter plane.
    const timer = window.setInterval(read, USAGE_REFRESH_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [rpc, showUsage])

  // The preference gates the whole affordance: hidden stops polling (the
  // effect above returns early) and renders nothing.
  if (!showUsage) return null

  const primary = usage?.primary
  if (primary === undefined || primary.used === undefined || primary.limit === undefined) {
    return null
  }
  // A custom cap overrides the meter's reported limit, so the percentage and
  // tooltip reflect a budget the user set rather than the provider's cycle.
  const limit = customLimit ?? primary.limit
  const usedPct = limit > 0
    ? Math.min(Math.max((primary.used / limit) * 100, 0), 100)
    : undefined
  const pct = usedPct ?? 0
  const derived: UsageWindow = {
    name: primary.name,
    used: primary.used,
    limit,
    ...usedPct === undefined ? {} : { usedPercent: usedPct },
    ...primary.resetsAt === undefined ? {} : { resetsAt: primary.resetsAt },
  }
  const label = usageTooltip(derived, t)
  const color = usageColor(derived.usedPercent, dangerPct)

  if (wide) {
    return h(Tooltip, { label, side: 'top', delayMs: 300 },
      h('div', { style: s.usageWrap },
        h('div', { style: s.usageBar },
          h('div', { style: { ...s.usageFill, width: `${Math.min(pct, 100)}%`, background: color } }),
        ),
        h('span', { style: s.usagePct }, `${Math.round(pct)}%`),
      ),
    )
  }
  // Rail: a ring whose arc fills with usage, with the percentage centered
  // inside it. The full label stays in the tooltip so the rail column keeps its
  // icon-only geometry; the ring is sized to fit a two-digit percentage. The
  // arc circles are rotated -90° about their center so the fill starts at 12
  // o'clock, while the svg itself stays unrotated so the centered text renders
  // upright.
  const size = 28
  const stroke = 2.5
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const c = 2 * Math.PI * r
  const dash = (Math.min(pct, 100) / 100) * c
  const arcTransform = `rotate(-90 ${cx} ${cy})`
  return h(Tooltip, { label, side: 'right', delayMs: 300 },
    h('div', { style: s.usageRail },
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
    ),
  )
}

/** How often the usage indicator refreshes, in ms. */
const USAGE_REFRESH_MS = 60_000

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
  const [showUsage, setShowUsage] = useState<boolean>(getUsagePref())
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [customLimit, setCustomLimitState] = useState<number | undefined>(getCustomLimit())
  // The text field mirrors the persisted value; it holds the user's in-progress
  // typing (including the empty string for "clear") and commits on blur/change.
  const [limitText, setLimitText] = useState<string>(customLimit === undefined ? '' : String(customLimit))
  const [dangerPct, setDangerPctState] = useState<number>(getDangerPct())
  const [dangerText, setDangerText] = useState<string>(String(getDangerPct()))

  // Keep the controls in sync with preference flips from the sidebar or other
  // tabs; the sidebar indicator reads the same store, so the two stay aligned.
  useEffect(() => subscribeUsagePref(() => {
    setShowUsage(getUsagePref())
    const next = getCustomLimit()
    setCustomLimitState(next)
    setLimitText(next === undefined ? '' : String(next))
    const danger = getDangerPct()
    setDangerPctState(danger)
    setDangerText(String(danger))
  }), [])

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

  // The usage preferences (show/hide, custom cap, danger threshold) are UI-only
  // and persist in localStorage, so they are configurable whether or not an
  // account is signed in — a user can set them up before first login.
  const usagePrefs = h(UsagePrefRows, {
    t,
    showUsage,
    menuOpen,
    setMenuOpen,
    limitText,
    setLimitText,
    dangerText,
    setDangerText,
  })

  return h('div', { style: s.section },
    h('h2', { style: s.title }, 'CodeBuddy'),
    !signedIn ? h('p', { style: s.desc }, t('intro')) : null,
    error !== undefined ? h('p', { style: s.error }, error) : null,
    signedIn
      ? h('div', { style: s.status },
          h(StatusRow, { label: t('nickname'), value: status?.nickname ?? '—' }),
          status?.uid !== undefined ? h(StatusRow, { label: t('uid'), value: status.uid }) : null,
          status?.uin !== undefined ? h(StatusRow, { label: t('uin'), value: status.uin }) : null,
          status?.enterpriseName !== undefined
            ? h(StatusRow, { label: t('enterprise'), value: status.enterpriseName })
            : null,
          status?.enterpriseId !== undefined
            ? h(StatusRow, { label: t('enterpriseId'), value: status.enterpriseId })
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
          usagePrefs,
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
          usagePrefs,
        ),
  )
}

/**
 * The three usage-preference rows, extracted so they render under both the
 * signed-in and signed-out branches — they are UI-only and persist regardless
 * of login state.
 */
function UsagePrefRows({ t, showUsage, menuOpen, setMenuOpen, limitText, setLimitText, dangerText, setDangerText }: {
  t: Translate
  showUsage: boolean
  menuOpen: boolean
  setMenuOpen: (update: boolean | ((prev: boolean) => boolean)) => void
  limitText: string
  setLimitText: (v: string) => void
  dangerText: string
  setDangerText: (v: string) => void
}): ReactElement {
  return h(Fragment, null,
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
          setUsagePref(id === '1')
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
          h(IconChevronDownOutline14),
        ),
      }),
    ),
    // Custom quota cap: overrides the meter's reported limit so the percentage
    // reflects a budget the user set. Empty = use the server's limit.
    h('div', { className: 'cb-prefRow' },
      h('div', { className: 'cb-prefRowText' },
        h('div', { className: 'cb-prefTitle' }, t('customLimit')),
        h('div', { className: 'cb-prefDesc' }, t('customLimitDesc')),
      ),
      h(Input, {
        type: 'number',
        inputMode: 'numeric',
        min: 0,
        step: 1,
        placeholder: t('customLimitPlaceholder'),
        className: 'cb-prefInput',
        value: limitText,
        onChange: (e: ChangeEvent<HTMLInputElement>) => { setLimitText(e.currentTarget.value) },
        onBlur: () => {
          const parsed = Number(limitText)
          if (limitText.length === 0 || !Number.isFinite(parsed) || parsed <= 0) {
            setCustomLimit(undefined)
          } else {
            setCustomLimit(parsed)
          }
        },
      }),
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
        min: 1,
        max: 100,
        step: 1,
        className: 'cb-prefInput',
        value: dangerText,
        onChange: (e: ChangeEvent<HTMLInputElement>) => { setDangerText(e.currentTarget.value) },
        onBlur: () => {
          const parsed = Number(dangerText)
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
            setDangerPct(undefined)
            setDangerText(String(getDangerPct()))
          } else {
            const clamped = Math.round(parsed)
            setDangerPct(clamped)
            setDangerText(String(clamped))
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
    'waiting': '等待浏览器登录完成…',
    'signIn': '登录',
    'signingIn': '登录中…',
    'signOut': '退出登录',
    'timeout': '登录超时，请重试。',
    'nickname': '昵称',
    'uid': 'UID',
    'uin': 'UIN',
    'enterprise': '企业',
    'enterpriseId': '企业 ID',
    'enterpriseUser': '企业用户名',
    'department': '部门',
    'showUsage': '显示额度余量',
    'showUsageDesc': '在侧边栏底部设置按钮上方显示已用额度进度。',
    'on': '开',
    'off': '关',
    'customLimit': '自定义额度上限',
    'customLimitDesc': '覆盖服务端上报的总量，按此值计算已用百分比。留空则使用服务端总量。',
    'customLimitPlaceholder': '使用默认',
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
    'waiting': 'Waiting for the browser sign-in to complete…',
    'signIn': 'Sign in',
    'signingIn': 'Signing in…',
    'signOut': 'Sign out',
    'timeout': 'Sign-in timed out. Please try again.',
    'nickname': 'Nickname',
    'uid': 'UID',
    'uin': 'UIN',
    'enterprise': 'Enterprise',
    'enterpriseId': 'Enterprise ID',
    'enterpriseUser': 'Enterprise user',
    'department': 'Department',
    'showUsage': 'Show usage allowance',
    'showUsageDesc': 'Display the used-allowance progress above the Settings button at the sidebar foot.',
    'on': 'On',
    'off': 'Off',
    'customLimit': 'Custom quota cap',
    'customLimitDesc': 'Overrides the server-reported limit when computing the used percentage. Leave empty to use the server value.',
    'customLimitPlaceholder': 'Default',
    'dangerPct': 'Low-allowance alert',
    'dangerPctDesc': 'The fill turns red once used usage reaches this percentage. Defaults to 90%.',
    'usageUsed': 'Usage',
    'usageResets': 'Resets at',
  },
}

/** A bound translate function, passed to the section through `inject`. */
type Translate = (key: string, params?: Record<string, string>) => string

export const inject = ['slots', 'locale', 'connection'] as const

/**
 * Scoped CSS for the CodeBuddy settings rows.
 *
 * The shipped General-section rows (Enter behavior, Appearance) use CSS-module
 * classNames whose `:hover` and focus styles the dsh-css system injects; an
 * inline `style` object cannot express those pseudo-states, so the selector
 * looked flat and dead. This injects one `<style>` tag carrying the same
 * selector affordance (hover background + focus ring) under a plugin-scoped
 * class, mirroring how the shell's own feature plugins attach their CSS.
 */
const PREF_CSS = `
.cb-prefRow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.cb-prefRowText{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;padding-right:48px}
.cb-prefTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.cb-prefDesc{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px}
.cb-prefSelector{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;flex:none}
.cb-prefSelector:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cb-prefSelector:focus-visible{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cb-prefInput{width:120px}
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

  // A usage indicator above the Settings trigger: the sidebar foot renders
  // `sidebar.footer.action` entries above the settings seat, so this lands
  // directly above the Settings button. It renders nothing while signed out or
  // while the meter plane is unreachable, so the column geometry is unchanged.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'codebuddy-usage',
    order: 10,
    locale: NS,
    inject: injected,
  }, UsageIndicator))
}
