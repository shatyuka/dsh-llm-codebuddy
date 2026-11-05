/**
 * CodeBuddy's business logic.
 *
 * The browser login waits on a human, so it is split: `startLogin` mints the
 * handshake, `pollLogin` follows it, and `cancelLogin` releases one abandoned
 * before it commits. `status` and `logout` are the read/clear pair the settings
 * page drives the rest of the time.
 *
 * The wire face is `CodeBuddyRemote`; this class owns no transport.
 *
 * @module dsh-llm-codebuddy/service
 */

import { getLoginAccount, pollAuthToken, requestAuthState } from './codebuddy.js'
import { buildStorage } from './login.js'
import type { CodeBuddySiteId } from './constants.js'
import type { CodeBuddySession } from './session.js'
import { clearStorage, loadStorage, saveStorage } from './storage.js'
import type { CodeBuddyStorage } from './storage.js'
import { hasDisclosedCapacity, isPromotionActive } from './types.js'
import { prefersChinese } from './locale.js'
import type { MessageLocale } from './locale.js'
import type { CodeBuddyModel, CodeBuddyModelPromotion, CodeBuddyPromotionDiscount } from './types.js'
import type { UsageSnapshot, UsageWindow } from './usage.js'
import type {
  CodeBuddyAuthStatus,
  CodeBuddyLoginPoll,
  CodeBuddyLoginStart,
  CodeBuddyModelEntry,
  CodeBuddyModelsResult,
  CodeBuddyPromotionView,
  CodeBuddyUsageResult,
  CodeBuddyUsageWindow,
} from './protocol.js'

export type {
  CodeBuddyAuthStatus,
  CodeBuddyLoginPoll,
  CodeBuddyLoginStart,
  CodeBuddyModelEntry,
  CodeBuddyModelsResult,
  CodeBuddyPromotionView,
  CodeBuddyUsageResult,
  CodeBuddyUsageWindow,
} from './protocol.js'

/** One in-flight browser-login handshake, keyed by its own state. */
interface PendingLogin {
  state: string
  controller: AbortController
  /** Resolves to the persisted storage once `pollAuthToken` succeeds. */
  promise: Promise<CodeBuddyStorage | undefined>
}

/**
 * Project one owned-data {@link UsageWindow} into the RPC-safe shape the
 * client receives, widening optional fields only when present.
 * @param window - the metering window.
 * @returns the client-safe projection.
 */
function projectWindow(window: UsageWindow): CodeBuddyUsageWindow {
  return {
    name: window.name,
    ...window.used === undefined ? {} : { used: window.used },
    ...window.limit === undefined ? {} : { limit: window.limit },
    ...window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent },
    ...window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt },
  }
}

/**
 * Project one catalog model into the RPC-safe shape the client receives.
 * `undefined` optionals are widened only when present, so the client can test
 * for absence with a single `!== undefined`.
 *
 * The description resolves to one string here, since the host knows the
 * language and the client renders only one of CodeBuddy's wordings.
 * @param model - one catalog entry.
 * @param promotion - the winning promotion's display facts, when one runs.
 * @param zh - whether the browser is displaying Chinese.
 */
function projectModel(
  model: CodeBuddyModel,
  promotion: CodeBuddyPromotionView | undefined,
  zh: boolean,
): CodeBuddyModelEntry {
  const description = zh
    ? model.descriptionZh ?? model.descriptionEn
    : model.descriptionEn ?? model.descriptionZh
  return {
    id: model.id,
    name: model.name,
    ...model.credits === undefined ? {} : { credits: model.credits },
    ...model.tags === undefined || model.tags.length === 0 ? {} : { tags: model.tags },
    ...description === undefined ? {} : { description },
    ...promotion === undefined ? {} : { promotion },
  }
}

/**
 * The active promotion for one model, when one runs.
 *
 * Among the promotions whose `modelIds` cover the model and whose schedule is
 * currently active, the highest `priority` wins. Only the display facts (badge
 * color/label, hover texts, discounted rate) cross the wire; scheduling stays
 * host-side.
 * @param promotions - the promotions from the config read.
 * @param modelId - the model to resolve for.
 * @returns the winning promotion's display facts, or undefined.
 */
function promotionFor(
  promotions: readonly CodeBuddyModelPromotion[],
  modelId: string,
  zh: boolean,
): CodeBuddyPromotionView | undefined {
  let winner: { priority: number, view: CodeBuddyPromotionView } | undefined
  for (const promotion of promotions) {
    if (promotion.modelIds === undefined || !promotion.modelIds.includes(modelId)) continue
    if (!isPromotionActive(promotion)) continue
    const { color, label } = promotion.badge ?? {}
    if (color === undefined || label === undefined) continue
    const priority = promotion.priority ?? 0
    if (winner !== undefined && winner.priority >= priority) continue
    const { textZh, textEn } = promotion.hover ?? {}
    const text = zh ? textZh ?? textEn : textEn ?? textZh
    const discountedRate = discountedRateOf(promotion.discount)
    winner = {
      priority,
      view: {
        color,
        label,
        ...text === undefined ? {} : { text },
        ...discountedRate === undefined ? {} : { discountedRate },
      },
    }
  }
  return winner?.view
}

/**
 * Normalize a promotion's price override into a display label: the
 * pre-formatted string wins when it parses, otherwise the numeric factor.
 * @param discount - the promotion's price override, when it carries one.
 * @returns the normalized `xN.nn` label, or undefined.
 */
function discountedRateOf(discount: CodeBuddyPromotionDiscount | undefined): string | undefined {
  if (discount === undefined) return undefined
  const fromLabel = parseRateLabel(discount.discountedCredits)
  if (fromLabel !== undefined) return fromLabel
  if (discount.factor !== undefined && Number.isFinite(discount.factor) && discount.factor >= 0) {
    return `x${discount.factor.toFixed(2)}`
  }
  return undefined
}

/** Parse a rate label ("x0.79", "0.5x", "0") into `xN.nn`, or undefined. */
function parseRateLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  const match = /(\d+(?:\.\d+)?)/.exec(label)
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const value = Number.parseFloat(digits)
  if (!Number.isFinite(value)) return undefined
  return `x${value.toFixed(2)}`
}

/**
 * The CodeBuddy service.
 *
 * A handshake is started by `startLogin`, polled to completion by `pollLogin`
 * (or released early by `cancelLogin`), and its credential is picked up by the
 * adapter's `CodeBuddySession` on its next request — so a login completed
 * through the UI reaches a running harness without a restart. `logout` cancels
 * any in-flight handshake first, then clears the file and invalidates the
 * session cache.
 */
export class CodeBuddyService {
  /** In-flight handshakes by state id. */
  private readonly pending = new Map<string, PendingLogin>()

  constructor(
    private readonly session?: CodeBuddySession,
    private readonly locale?: MessageLocale,
  ) {}

  /**
   * Read the stored credential without requiring one.
   *
   * A stored file is not sufficient for `loggedIn: true`: a session whose
   * access and refresh tokens have both expired reads as signed in but fails
   * every request, which leaves the settings page claiming an account while the
   * model list is empty and no error is shown. The credential is therefore
   * probed for usability, and an unusable one reports `loggedIn: false` so the
   * page offers the sign-in affordance. An unreachable service still reports
   * signed in — the credential was not refused.
   * @returns the current auth status; `loggedIn` is false when nothing usable is stored.
   */
  async status(): Promise<CodeBuddyAuthStatus> {
    const stored = await loadStorage()
    if (stored === undefined) {
      return { loggedIn: false }
    }
    if (!(await this.session?.isUsable() ?? true)) {
      // A credential is on disk but cannot authenticate: report the expiry so
      // the page asks for a fresh sign-in instead of looking merely unused.
      return { loggedIn: false, expired: true }
    }
    return {
      loggedIn: true,
      nickname: stored.account.nickname,
      uid: stored.account.uid,
      ...stored.account.uin === undefined ? {} : { uin: stored.account.uin },
      ...stored.auth.domain.length === 0 ? {} : { domain: stored.auth.domain },
      ...stored.account.enterpriseId === undefined ? {} : { enterpriseId: stored.account.enterpriseId },
      ...stored.account.enterpriseName === undefined ? {} : { enterpriseName: stored.account.enterpriseName },
      ...stored.account.enterpriseUserName === undefined ? {} : { enterpriseUserName: stored.account.enterpriseUserName },
      ...stored.account.departmentFullName === undefined ? {} : { departmentFullName: stored.account.departmentFullName },
    }
  }

  /**
   * Start a browser-login handshake.
   * @param site - the deployment to sign in to.
   * @returns the URL the user must open.
   */
  async startLogin(site: CodeBuddySiteId): Promise<CodeBuddyLoginStart> {
    const handshake = await requestAuthState(site)
    const controller = new AbortController()
    const pending: PendingLogin = {
      state: handshake.state,
      controller,
      promise: this.runLogin(site, handshake.state, controller.signal),
    }
    this.pending.set(handshake.state, pending)
    // Reap the entry once the handshake settles either way, so the table does
    // not grow without bound for abandoned logins.
    void pending.promise.finally(() => {
      if (this.pending.get(handshake.state) === pending) {
        this.pending.delete(handshake.state)
      }
    })
    return { authUrl: handshake.authUrl, state: handshake.state }
  }

  /**
   * Check whether a started handshake has completed.
   * @param state - the handshake id from `startLogin`.
   * @returns whether the login completed and the credential was persisted.
   */
  async pollLogin(state: string): Promise<CodeBuddyLoginPoll> {
    const pending = this.pending.get(state)
    if (pending === undefined) {
      // Unknown/already-reaped state: surface as not-done rather than an error,
      // because the client's poll loop may outlive the entry by one tick.
      return { done: false }
    }
    const storage = await pending.promise
    return {
      done: storage !== undefined,
      ...storage !== undefined ? { nickname: storage.account.nickname } : {},
    }
  }

  /**
   * Cancel a started browser-login handshake.
   *
   * The entry is dropped first so no later `pollLogin` attaches to it, and the
   * run is awaited rather than merely signalled: `abort()` only requests
   * cancellation, so returning early would report a cancel while the run may
   * still be writing a credential.
   * @param state - the handshake id from `startLogin`.
   */
  async cancelLogin(state: string): Promise<void> {
    const pending = this.pending.get(state)
    if (pending === undefined) return
    this.pending.delete(state)
    pending.controller.abort()
    await pending.promise
  }

  /**
   * Cancel every in-flight handshake and await them all.
   *
   * `logout` needs this: a run still in flight would otherwise persist its
   * credential *after* the store was cleared.
   */
  private async cancelAllLogins(): Promise<void> {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.controller.abort()
    await Promise.all(pending.map(entry => entry.promise))
  }

  /** Remove the stored credential. */
  async logout(): Promise<void> {
    await this.cancelAllLogins()
    await clearStorage()
    // Drop the in-memory cache so the next request re-reads disk (finds
    // nothing) instead of serving the now-revoked token.
    this.session?.invalidate()
    // The picker's model list belonged to the account that just left; announce
    // so the client drops it instead of showing a signed-out user its models.
    this.session?.announceCatalogChange()
  }

  /**
   * Read the CodeBuddy usage snapshot for the settings surface.
   *
   * Delegates to the session, which resolves a refreshed identity before the
   * meter read and never throws on a meter outage. A signed-out account is
   * reported as `loggedIn: false` with empty windows so the client can hide
   * the affordance rather than render a broken bar.
   * @returns the usage projection, or a signed-out shape when nothing is stored.
   */
  async usage(): Promise<CodeBuddyUsageResult> {
    const snapshot: UsageSnapshot | undefined = await this.session?.usage()
    if (snapshot === undefined) {
      return { loggedIn: false, windows: [] }
    }
    const windows = snapshot.windows.map(projectWindow)
    const primary = snapshot.primary !== undefined ? projectWindow(snapshot.primary) : undefined
    return { loggedIn: true, windows, ...primary === undefined ? {} : { primary } }
  }

  /**
   * Read the CodeBuddy model catalog with its display facts (credits, tags,
   * locale descriptions) for the model selector.
   *
   * Bypasses the session's catalog TTL: this endpoint is called when the user
   * opens the model menu, which is exactly the moment a server-side add or
   * delete must become visible rather than up to five minutes later. The read
   * is single-flighted and floor-limited inside the session, so a burst of
   * opens costs at most one config request. When the read changes the catalog,
   * the session notifies the plugin, which republishes `llm/adapters-updated`
   * so the harness catalog the client renders its groups from is dropped and
   * refetched too — otherwise the enriched rows here would update while the
   * group list stayed stale.
   *
   * Only models with disclosed capacities are shipped — the same offerability
   * rule `listModels` applies, so the client's enriched rows align with the
   * rows the harness catalog already renders.
   * @returns the enriched catalog, or a signed-out shape when nothing usable is stored.
   */
  async models(): Promise<CodeBuddyModelsResult> {
    if (this.session === undefined) return { loggedIn: false, models: [] }
    // Report the real login state rather than an unconditional `true`: the
    // client uses this flag to decide whether to render the rows at all, and a
    // signed-out session must not look like a signed-in one with no models.
    if (!(await this.session.isUsable())) return { loggedIn: false, models: [] }
    const { models, promotions } = await this.session.refreshCatalog()
    // Read once per catalog read, so one menu cannot split between wordings.
    const zh = prefersChinese(this.locale?.tag())
    return {
      loggedIn: true,
      models: models.filter(hasDisclosedCapacity).map(model =>
        projectModel(model, promotionFor(promotions, model.id, zh), zh)),
    }
  }

  /**
   * Drive one handshake to a persisted credential.
   *
   * Reuses `buildStorage` so the on-disk shape is identical to the CLI login.
   * Returns `undefined` on any failure so the client's poll resolves
   * `done: false` and may retry from `startLogin`.
   *
   * The signal cancels the in-flight reads, narrowing the window in which a
   * cancel can still commit: an abort that lands after the check below cannot
   * stop the write, so the closing guarantee is not this check but the callers
   * — `cancelLogin` and `logout` await this run before reporting, and the
   * client re-reads `status` rather than assuming the cancel won.
   */
  private async runLogin(site: CodeBuddySiteId, state: string, signal: AbortSignal): Promise<CodeBuddyStorage | undefined> {
    try {
      const token = await pollAuthToken(site, state, signal)
      if (token === undefined) return undefined
      const account = await getLoginAccount(site, state, token.accessToken, token.domain, signal)
      // Last chance to drop a cancelled attempt before anything is persisted.
      if (signal.aborted) return undefined
      const storage = buildStorage(site, token, account)
      await saveStorage(storage)
      // Drop the in-memory cache so the next request picks up the freshly
      // written credential rather than the pre-login one.
      this.session?.invalidate()
      // The new account has its own model list; announce so the client drops
      // whatever it cached for the previous (possibly signed-out) state.
      this.session?.announceCatalogChange()
      return storage
    } catch {
      // A transport or service failure ends the handshake; the client may
      // retry from `startLogin`.
      return undefined
    }
  }
}
