/**
 * CodeBuddy quota/usage meter: fetch and parse the remaining allowance.
 *
 * CodeBuddy splits its billing plane in two: an enterprise tenant answers
 * `get-enterprise-user-usage` (a single limit/credit pair), while a personal
 * account answers `get-user-resource` (one window per active package). The two
 * shapes share nothing but the authenticated headers every CodeBuddy request
 * carries, so the transport and parsing paths fork once on whether the
 * signed-in account disclosed an `enterpriseId`.
 *
 * Every value that crosses into the Web client is a plain number/string, so
 * the {@link UsageSnapshot} returned here is owned data — no live session
 * object escapes this module.
 *
 * @module dsh-llm-codebuddy/usage
 */

import { CODEBUDDY_IDE_USER_AGENT, endpointOf } from './constants.js'
import { usedPercent } from './quota.js'
import type { CodeBuddyIdentity } from './codebuddy.js'

/** One metering window: a named allowance and how much of it is spent. */
export interface UsageWindow {
  /** Human-readable package name, when the catalog discloses one. */
  name: string
  /** Amount already consumed; `undefined` when the plane does not report it. */
  used?: number
  /**
   * Total allowance for this window; `undefined` only when the plane disclosed
   * no capacity at all. A disclosed `0` is a real budget of zero and is kept.
   */
  limit?: number
  /**
   * Used as a percentage of `limit`, clamped to [0, 100]. Present whenever a
   * limit was disclosed; a zero budget has no headroom and so reads 100%.
   * `undefined` only when no capacity was disclosed.
   */
  usedPercent?: number
  /** ISO-ish timestamp the window resets at, when disclosed. */
  resetsAt?: string
}

/** The parsed usage a settings surface renders. */
export interface UsageSnapshot {
  /** One entry per metering window the plane reported; empty on failure. */
  windows: UsageWindow[]
  /**
   * The figures a single-bar affordance should reflect.
   *
   * Enterprise tenants report exactly one window. A personal account reports one
   * window per active package and draws down a base package plus any granted
   * ones, so this carries the sum across every metered package rather than any
   * single package's figures; `windows` keeps the per-package detail.
   */
  primary?: UsageWindow
}

/** An envelope error reply from the meter plane. */
interface MeterErrorResponse {
  code?: number
  msg?: string
}

/**
 * The authenticated headers every CodeBuddy meter request carries.
 *
 * Mirrors {@link CodeBuddySession.authHeaders} plus the user-agent the catalog
 * read adds, because the meter plane rejects a request missing it just as
 * `/v3/config` does. Kept here rather than re-exported from the session so the
 * meter path owns its own header set and never couples to the chat adapter's.
 * @param identity - the signed-in identity.
 * @returns the request headers.
 */
function meterHeaders(identity: CodeBuddyIdentity): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': CODEBUDDY_IDE_USER_AGENT,
    'Authorization': `Bearer ${identity.accessToken}`,
    'X-Domain': identity.domain,
    'X-User-Id': identity.uid,
  }
  if (identity.enterpriseId !== undefined) {
    headers['X-Enterprise-Id'] = identity.enterpriseId
    // The meter plane expects the tenant id echoed under both names; a request
    // carrying only one of them is rejected.
    headers['X-Tenant-Id'] = identity.enterpriseId
  }
  if (identity.departmentFullName !== undefined) {
    headers['X-Department-Info'] = identity.departmentFullName
  }
  return headers
}

/** Read a numeric field that may arrive as a number or a numeric string. */
function number(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    // Blank means "not disclosed"; `Number('')` is 0, which would otherwise
    // masquerade as a disclosed zero budget.
    if (raw.trim().length === 0) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Read a non-empty string field. */
function string(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** Follow a chain of object keys through a JSON value, returning the leaf or undefined. */
function pointer(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Format a Unix timestamp as `YYYY-MM-DD HH:mm:ss` in the local timezone, the
 * shape the personal meter expects for its `SlicePeriod*` bounds.
 *
 * The service accepts either UTC or local as long as both bounds share the
 * convention, and local formatting is what this client sends.
 * @param timestamp - Unix seconds.
 * @returns the formatted timestamp.
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const pad = (n: number): string => n < 10 ? `0${n}` : String(n)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Normalize a personal package's reset timestamp.
 *
 * CodeBuddy reports a package's `CycleEndTime` as the close of its last active
 * day (`23:59:59`). That reads as "resets just before midnight" but the quota
 * actually resets at the following day's `00:00:00`, so the displayed value is
 * bumped by one second into the next day when it ends at `23:59:59`. Any other
 * value passes through unchanged, and an unparseable timestamp is returned as
 * given rather than dropped (the figure is still better than none).
 * @param raw - the `CycleEndTime` string, `YYYY-MM-DD HH:mm:ss`.
 * @returns the normalized timestamp string.
 */
function normalizeResetTime(raw: string): string {
  if (!raw.endsWith('23:59:59')) return raw
  // `YYYY-MM-DD HH:mm:ss` → ISO `YYYY-MM-DDTHH:mm:ss` so Date parses it
  // (the space form is non-standard and yields Invalid Date in strict engines).
  const date = new Date(raw.replace(' ', 'T'))
  // `Invalid Date` from an unexpected shape: leave the raw value intact.
  if (Number.isNaN(date.getTime())) return raw
  date.setSeconds(date.getSeconds() + 1)
  const pad = (n: number): string => n < 10 ? `0${n}` : String(n)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Parse the personal account's `get-user-resource` reply.
 *
 * The accounts array may sit under several pointer roots depending on the
 * gateway the request traversed; each is tried in order and the first array
 * found wins. Each account contributes one {@link UsageWindow} named after its
 * package code, with `used` derived as `limit - remaining` (so a remaining
 * figure that exceeds the cap is clamped to zero used rather than negative).
 * @param accounts - the located accounts array.
 * @returns the assembled snapshot.
 */
function personalUsage(accounts: unknown[]): UsageSnapshot {
  const windows: UsageWindow[] = accounts.map((resource, index): UsageWindow => {
    // A package disclosing NO capacity is uncapped/unknown: it contributes only
    // its name, so the affordance can say "no quota" instead of drawing a
    // meaningless zero-of-zero. A disclosed zero is a real budget of zero, so
    // the two are told apart by presence, not by value.
    const disclosed = number(resource, 'CycleCapacitySizePrecise')
    const left = number(resource, 'CycleCapacityRemainPrecise') ?? 0
    const name = string(resource, 'PackageCode')
      ?? string(resource, 'ResourceId')
      ?? `resource_${index}`
    const rawReset = string(resource, 'CycleEndTime')
    // A package's `CycleEndTime` lands on `23:59:59` of its last active day;
    // bump it into the following `00:00:00`, which is the moment the quota
    // actually resets.
    const resetsAt = rawReset === undefined ? undefined : normalizeResetTime(rawReset)
    if (disclosed === undefined) {
      return { name, ...resetsAt === undefined ? {} : { resetsAt } }
    }
    const limit = Math.max(disclosed, 0)
    const used = Math.max(limit - left, 0)
    return {
      name,
      used,
      limit,
      usedPercent: usedPercent(used, limit),
      ...resetsAt === undefined ? {} : { resetsAt },
    }
  })
  // Aggregate rather than surfacing `windows[0]`: a personal account draws down
  // a base package plus any granted ones, and the first listed package is
  // arbitrary — showing it alone reads 100% once the base empties even though
  // the grants that pay for the next request are untouched. Summing every
  // window that disclosed a limit matches the total the console reports; an
  // all-zero account totals zero and so reads 100%.
  type MeteredWindow = UsageWindow & { used: number, limit: number }
  const metered = windows.filter((window): window is MeteredWindow =>
    window.limit !== undefined && window.used !== undefined)
  if (metered.length === 0) {
    return { windows, ...windows.length > 0 ? { primary: windows[0] } : {} }
  }
  const totalUsed = metered.reduce((sum, window) => sum + window.used, 0)
  const totalLimit = metered.reduce((sum, window) => sum + window.limit, 0)
  // A package's reset only matters while it still holds credits: a spent base
  // package resetting tomorrow must not mask the grant that expires in a month.
  // Once every package is spent there is nothing to fall back on but the
  // earliest reset overall, which is the one the account is waiting on.
  const withHeadroom = metered.filter(window => window.limit - window.used > 0)
  const resetsAt = (withHeadroom.length > 0 ? withHeadroom : metered)
    .map(window => window.resetsAt)
    .filter(value => value !== undefined)
    .sort()[0]
  const primary: UsageWindow = {
    name: 'total',
    used: totalUsed,
    limit: totalLimit,
    usedPercent: usedPercent(totalUsed, totalLimit),
    ...resetsAt === undefined ? {} : { resetsAt },
  }
  return { windows, primary }
}

/**
 * Parse the enterprise tenant's `get-enterprise-user-usage` reply.
 *
 * The enterprise plane reports a single `limitNum`/`credit` pair under `data`
 * (or at the root when the gateway does not wrap it), so one window is built.
 * @param data - the data object the figures live in.
 * @returns the assembled snapshot, or `undefined` when no limit was disclosed.
 */
function enterpriseUsage(data: unknown): UsageSnapshot | undefined {
  // An absent `limitNum` means no cap was disclosed; a present zero is a real
  // budget of zero and is kept.
  const disclosed = number(data, 'limitNum')
  if (disclosed === undefined) return undefined
  const limit = Math.max(disclosed, 0)
  const used = number(data, 'credit') ?? 0
  const reset = string(data, 'cycleResetTime')
  const window: UsageWindow = {
    name: 'enterprise',
    used,
    limit,
    usedPercent: usedPercent(used, limit),
    ...reset === undefined ? {} : { resetsAt: reset },
  }
  return { windows: [window], primary: window }
}

/**
 * Parse one meter reply into a snapshot.
 *
 * The personal `Accounts` array is tried under either pointer root first, and
 * the enterprise single-window parse is the fallback when no array matched,
 * regardless of which request path was sent. That order keeps a personal
 * account that happens to carry an `enterpriseId` (or vice versa) parsing the
 * shape it actually answered, rather than the shape its credential suggested
 * it would.
 * @param raw - the parsed reply body.
 * @returns the assembled snapshot, or `undefined` when the body carried nothing parseable.
 */
export function parseUsage(raw: unknown): UsageSnapshot | undefined {
  // Either root the personal plane nests the array under.
  const accountsRoots: readonly (readonly string[])[] = [
    ['data', 'Response', 'Data', 'Accounts'],
    ['data', 'data', 'Response', 'Data', 'Accounts'],
    ['Response', 'Data', 'Accounts'],
  ]
  for (const path of accountsRoots) {
    const candidate = pointer(raw, path)
    if (Array.isArray(candidate)) {
      return personalUsage(candidate)
    }
    if (candidate === null) {
      return { windows: [] }
    }
  }
  const data = pointer(raw, ['data', 'data']) ?? pointer(raw, ['data']) ?? raw
  return enterpriseUsage(data)
}

/**
 * The personal meter's slice-period bounds, as today's local day.
 *
 * The plane's `SlicePeriod*` filter scopes each package's usage to the slice
 * that overlaps the range, so a same-day `00:00:00`–`23:59:59` window returns
 * the currently active billing cycle's figures (the package whose
 * `CycleStartTime` ≤ today ≤ `CycleEndTime`).
 * @returns the `{ begin, end }` pair as `YYYY-MM-DD HH:mm:ss` strings.
 */
function todayRange(): { begin: string, end: string } {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfDay = new Date(midnight)
  endOfDay.setHours(23, 59, 59, 0)
  return { begin: formatTime(midnight.getTime() / 1000), end: formatTime(endOfDay.getTime() / 1000) }
}

/**
 * POST to a meter endpoint and parse the reply, with every failure mode
 * degrading to `undefined` rather than throwing.
 *
 * Usage is an advisory read on a settings surface, so a transport fault, a
 * non-2xx status, an unparseable body, or a non-zero service `code` all mean
 * "no usage shown" — never a broken sidebar foot.
 * @param identity - the signed-in identity, refreshed by the session.
 * @param path - the meter path under the identity's own site endpoint.
 * @param body - the JSON request body.
 * @param signal - optional cancellation.
 * @returns the parsed snapshot, or `undefined` when the plane was unreachable
 *   or answered an unusable body.
 */
async function postMeter(
  identity: CodeBuddyIdentity,
  path: string,
  body: string,
  signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
  let response: Response
  try {
    response = await fetch(`${endpointOf(identity.site)}${path}`, {
      method: 'POST',
      headers: meterHeaders(identity),
      body,
      ...signal === undefined ? {} : { signal },
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    return undefined
  }
  // The meter plane wraps errors as `{code, msg}`; a non-zero code is a
  // refused read and is not a usage snapshot.
  const envelope = raw as MeterErrorResponse | undefined
  if (envelope !== null && typeof envelope === 'object'
    && envelope.code !== undefined && envelope.code !== 0) {
    return undefined
  }
  return parseUsage(raw)
}

/**
 * Fetch the personal account's usage: one window per active package.
 *
 * The request carries the slice-period bounds (today's local day) and the
 * product/status filters the service expects.
 * @param identity - the signed-in identity, refreshed by the session.
 * @param signal - optional cancellation.
 * @returns the parsed snapshot, or `undefined` when the plane was unreachable.
 */
export async function fetchPersonalUsage(
  identity: CodeBuddyIdentity,
  signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
  const { begin, end } = todayRange()
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    SlicePeriodStartTime: begin,
    SlicePeriodEndTime: end,
  })
  return postMeter(identity, '/v2/billing/meter/get-user-resource', body, signal)
}

/**
 * Fetch the enterprise tenant's usage: a single `limitNum`/`credit` pair.
 *
 * The enterprise plane takes an empty body and answers under `data`, so the
 * request is just the authenticated POST.
 * @param identity - the signed-in identity, refreshed by the session.
 * @param signal - optional cancellation.
 * @returns the parsed snapshot, or `undefined` when the plane was unreachable.
 */
export async function fetchEnterpriseUsage(
  identity: CodeBuddyIdentity,
  signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
  return postMeter(identity, '/v2/billing/meter/get-enterprise-user-usage', '{}', signal)
}

/**
 * Fetch and parse the CodeBuddy usage snapshot, forking on the account kind.
 *
 * Delegates to {@link fetchPersonalUsage} or {@link fetchEnterpriseUsage}
 * depending on whether the signed-in identity disclosed an `enterpriseId`.
 * Every failure mode resolves to `undefined` rather than throwing; the caller
 * decides whether to retry.
 * @param identity - the signed-in identity, refreshed by the session.
 * @param signal - optional cancellation.
 * @returns the parsed snapshot, or `undefined` when the plane was unreachable
 *   or answered an unusable body.
 */
export async function fetchUsage(
  identity: CodeBuddyIdentity,
  signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
  return identity.enterpriseId !== undefined
    ? fetchEnterpriseUsage(identity, signal)
    : fetchPersonalUsage(identity, signal)
}
