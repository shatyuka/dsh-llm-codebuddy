/**
 * The signed-in session: token freshness and the cached model catalog.
 *
 * One object owns both because they share a failure mode — an expired token
 * makes the catalog unreadable — and because both must be resolved before a
 * request can be built. Refresh is single-flighted: the adapter resolves the
 * identity once per stream call and the catalog once per listing, so without
 * coalescing a burst of concurrent calls would each spend the refresh token
 * and all but one would be racing to write the file.
 *
 * @module dsh-llm-codebuddy/session
 */

import { createHash } from 'node:crypto'
import { ConfigRequestError, getConfig, refreshAccessToken } from './codebuddy.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
import { fetchUsage } from './usage.js'
import type { UsageSnapshot } from './usage.js'
import { loadStorage, saveStorage } from './storage.js'
import type { CodeBuddyStorage } from './storage.js'
import type { CodeBuddyModel, CodeBuddyModelPromotion } from './types.js'

/** Refresh this long before the recorded expiry rather than exactly at it. */
const REFRESH_SKEW_MS = 60_000

/** How long a read catalog is reused before the service is asked again. */
const CATALOG_TTL_MS = 5 * 60 * 1000

/**
 * Minimum spacing between forced catalog reads.
 *
 * A forced read exists so the picker can track server-side edits, but it costs
 * a `/v3/config` request. Opening the menu, the change that read announces, and
 * the client's consequent re-read can otherwise land within the same second, so
 * a forced read inside this floor degrades to the cached copy — whose
 * fingerprint is unchanged, so it announces nothing.
 */
const CATALOG_FORCE_FLOOR_MS = 3_000

/** Raised when nothing is signed in; carries the remedy in its message. */
export class NotLoggedInError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'NotLoggedInError'
  }
}

/**
 * Raised when the credential could not be validated because the service was
 * unreachable, so the stored session may well still be valid.
 *
 * Deliberately separate from {@link NotLoggedInError}: the remedy is to retry,
 * not to sign in again, and the adapter maps this to the retryable `TRANSPORT`
 * code rather than the terminal `MISSING_CREDENTIAL` one. Reporting a network
 * blip as an expired login would send a correctly-signed-in user through a
 * pointless browser handshake.
 */
export class SessionUnavailableError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'SessionUnavailableError'
  }
}

/** A logger surface compatible with cordis's, so the session can be used bare. */
export interface SessionLogger {
  warn: (message: unknown) => void
  error: (message: unknown) => void
}

/** One cached catalog read: the entries, the campaigns, and when they were read. */
interface CatalogSnapshot {
  models: readonly CodeBuddyModel[]
  promotions: readonly CodeBuddyModelPromotion[]
  readAt: number
  /** Stable digest of the offerable entries, compared to detect server-side edits. */
  fingerprint: string
}

/**
 * A stable digest of the catalog's user-visible content.
 *
 * Compared before and after a read so an unchanged catalog announces nothing —
 * a refresh that published unconditionally would make every menu open churn the
 * client's catalog, its groups, and every dependent surface. The digest covers
 * only what a picker renders (id, name, credits, tags, locale descriptions,
 * sizes, capability flags, and reasoning metadata), because anything else the
 * service echoes is not worth a client refetch; entries are sorted by id so a
 * reordering alone is not a change.
 *
 * `JSON.stringify` preserves the literal field order written here, so the
 * digest is stable across reads of an identical catalog.
 * @param models - the catalog entries to digest.
 * @returns a hex digest.
 */
function catalogFingerprint(models: readonly CodeBuddyModel[]): string {
  const projected = models
    .map(model => ({
      id: model.id,
      name: model.name,
      credits: model.credits,
      tags: model.tags,
      descriptionZh: model.descriptionZh,
      descriptionEn: model.descriptionEn,
      maxAllowedSize: model.maxAllowedSize,
      maxOutputTokens: model.maxOutputTokens,
      supportsImages: model.supportsImages,
      supportsToolCall: model.supportsToolCall,
      supportsReasoning: model.supportsReasoning,
      reasoning: model.reasoning,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(projected)).digest('hex')
}

/**
 * Owns the stored credential for one plugin instance.
 *
 * The credential is re-read from disk when absent from memory, which is what
 * lets `dsh-codebuddy-login` sign a *running* harness in without a restart.
 */
export class CodeBuddySession {
  private storage: CodeBuddyStorage | undefined
  /** In-flight disk read, shared so concurrent callers read the file once. */
  private storageRead: Promise<CodeBuddyStorage | undefined> | undefined
  /** Retires in-flight disk reads when the cached credential is dropped. */
  private storageGeneration = 0
  private refreshing: Promise<CodeBuddyIdentity> | undefined
  private catalog: CatalogSnapshot | undefined
  private catalogRead: Promise<CatalogSnapshot> | undefined
  /**
   * Digest of the last catalog ever read, kept across {@link invalidate} so a
   * credential change (a login as a different account) still announces the
   * catalog it replaces. A token refresh invalidates the cache but leaves this
   * alone, so the unchanged catalog announces nothing.
   */
  private lastFingerprint: string | undefined
  /**
   * Change listeners, fired after a read whose content differs from the last
   * one. Registered by the plugin so a catalog edit reaches the client without
   * a restart; the session itself stays transport-only and knows nothing about
   * cordis events.
   */
  private readonly catalogListeners = new Set<() => void>()

  constructor(private readonly logger?: SessionLogger) {}

  /**
   * Observe catalog content changes.
   * @param listener - called after a read that changed the catalog.
   * @returns the disposer that stops observing.
   */
  onCatalogChange(listener: () => void): () => void {
    this.catalogListeners.add(listener)
    return () => { this.catalogListeners.delete(listener) }
  }

  private emitCatalogChange(): void {
    for (const listener of [...this.catalogListeners]) {
      try {
        listener()
      } catch (error) {
        // One broken observer must not fail the read that announced it.
        this.logger?.warn('dsh-codebuddy: a model-catalog change listener failed')
        this.logger?.warn(error)
      }
    }
  }

  /**
   * Announce that whatever catalog consumers hold is no longer authoritative.
   *
   * Used when the *account* changes rather than the content — a sign-in or
   * sign-out replaces every model without a content diff to observe — so the
   * client drops the previous account's list instead of keeping it until some
   * later read happens to differ.
   */
  announceCatalogChange(): void {
    this.emitCatalogChange()
  }

  /**
   * Forget the in-memory credential and catalog, forcing a re-read from disk.
   *
   * Bumping the generation retires any disk read already in flight: it must not
   * install the snapshot it started from after this point, or a 401-triggered
   * invalidation could be undone by a read that was already underway.
   */
  invalidate(): void {
    this.storage = undefined
    this.catalog = undefined
    this.storageGeneration += 1
    // Drop the shared read so the next caller starts a fresh one instead of
    // reusing a snapshot this invalidation just retired.
    this.storageRead = undefined
  }

  private identityOf(storage: CodeBuddyStorage): CodeBuddyIdentity {
    return {
      accessToken: storage.auth.accessToken,
      domain: storage.auth.domain,
      uid: storage.account.uid,
      ...storage.account.enterpriseId === undefined
        ? {}
        : { enterpriseId: storage.account.enterpriseId },
      ...storage.account.departmentFullName === undefined
        ? {}
        : { departmentFullName: storage.account.departmentFullName },
    }
  }

  /**
   * The stored credential, read from disk on first use and after invalidation.
   * @throws NotLoggedInError when nothing is stored.
   */
  private async require(): Promise<CodeBuddyStorage> {
    const storage = await this.load()
    if (storage === undefined) {
      throw new NotLoggedInError(
        'CodeBuddy is not signed in. Sign in through the Settings page; no API key is required.',
      )
    }
    return storage
  }

  /**
   * Read the credential from disk, sharing one in-flight read and never
   * clobbering a newer value.
   *
   * The naive `this.storage ??= await loadStorage()` is wrong under
   * concurrency: the null check runs *before* the await while the assignment
   * runs after it, so a slow disk read can land after a token refresh has
   * already installed fresh tokens and overwrite them with the stale snapshot
   * it started from. The next caller then sees an expired access token again
   * and spends the refresh token a second time — and since CodeBuddy rotates
   * refresh tokens, replaying the spent one can end the session outright.
   *
   * The result is therefore adopted only if nothing newer arrived while the
   * read was in flight, and concurrent callers share the one read.
   * @returns the credential, or `undefined` when none is stored.
   */
  private async load(): Promise<CodeBuddyStorage | undefined> {
    if (this.storage !== undefined) return this.storage
    const generation = this.storageGeneration
    // Capture the promise locally rather than reading the shared slot at await
    // time: an invalidation during the read clears that slot, and this caller
    // must still settle on the read it actually started.
    let read = this.storageRead
    if (read === undefined) {
      read = loadStorage()
      this.storageRead = read
      // Both callbacks clear the slot, and `then` rather than `finally` is
      // deliberate: `finally` would forward a rejection into a derived promise
      // that nothing awaits, turning a failed read into an unhandled rejection
      // on top of the one this caller already sees.
      const clear = (): void => {
        // Clear only if the slot still holds this read; a newer one may have
        // replaced it.
        if (this.storageRead === read) this.storageRead = undefined
      }
      void read.then(clear, clear)
    }
    const loaded = await read
    // Adopt the read result only if nothing newer arrived meanwhile: a refresh,
    // a login, or an invalidation during the read all outrank this snapshot.
    if (this.storage === undefined && this.storageGeneration === generation && loaded !== undefined) {
      this.storage = loaded
    }
    return this.storage
  }

  /** Whether a credential exists at all, without requiring one. */
  async isLoggedIn(): Promise<boolean> {
    return await this.load() !== undefined
  }

  /** The signed-in nickname, when a credential exists. */
  async nickname(): Promise<string | undefined> {
    return (await this.load())?.account.nickname
  }

  /**
   * A usable identity, refreshing the access token when it is at or near
   * expiry. Concurrent callers share one refresh.
   * @returns the identity to authenticate a request with.
   * @throws NotLoggedInError when nothing is stored, or when the refresh token
   *   has itself expired and only a new browser login can recover.
   */
  async identity(): Promise<CodeBuddyIdentity> {
    const storage = await this.require()
    const now = Date.now()
    if (now < storage.auth.expiresAt - REFRESH_SKEW_MS) {
      return this.identityOf(storage)
    }
    if (now >= storage.auth.refreshExpiresAt) {
      throw new NotLoggedInError(
        'The CodeBuddy session has expired. Sign in again.',
      )
    }
    this.refreshing ??= this.refresh(storage).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  /**
   * Whether the stored credential can still authenticate a request.
   *
   * A stored file is not the same as a usable session: an expired access token
   * with an expired refresh token leaves a credential that reads as signed in
   * but fails every call. Surfaces that report login state use this instead of
   * {@link isLoggedIn} so they do not claim "signed in" while the model list is
   * empty.
   *
   * Resolving an identity is a pure local check when the access token is still
   * fresh (no network), and spends the refresh token only when it is at or near
   * expiry — the same work the next request would do anyway, and it is
   * single-flighted. An unreachable service is reported as `true`: the
   * credential was not refused, and flipping a user to "signed out" because the
   * network blipped would be wrong.
   * @returns true when a request could be authenticated (or might, if the
   *   service is merely unreachable).
   */
  async isUsable(): Promise<boolean> {
    try {
      await this.identity()
      return true
    } catch (error) {
      if (error instanceof NotLoggedInError) return false
      // An unreachable service says nothing about the credential's validity.
      return true
    }
  }

  private async refresh(storage: CodeBuddyStorage): Promise<CodeBuddyIdentity> {
    const result = await refreshAccessToken(this.identityOf(storage), storage.auth.refreshToken)
    if (!result.ok) {
      // A refusal is terminal for this credential; an unreachable service is
      // not, so it must not carry the "sign in again" remedy.
      throw result.reason === 'rejected'
        ? new NotLoggedInError(
            'Refreshing the CodeBuddy session failed. Sign in again.',
          )
        : new SessionUnavailableError(
            'Could not reach CodeBuddy to refresh the session; the stored credential was not'
            + ' rejected. Check the network and retry.',
          )
    }
    const refreshed = result.token
    const next: CodeBuddyStorage = {
      auth: {
        accessToken: refreshed.accessToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        refreshToken: refreshed.refreshToken,
        refreshExpiresAt: Date.now() + refreshed.refreshExpiresIn * 1000,
        domain: refreshed.domain,
      },
      account: storage.account,
    }
    this.storage = next
    // A catalog read under the old token is still valid, but the write below
    // may fail and leave the next process on a stale token; the catalog is
    // cheap to re-read, so it is dropped rather than reasoned about.
    this.catalog = undefined
    try {
      await saveStorage(next)
    } catch (error) {
      // The refreshed token works for this process even if it could not be
      // persisted; failing the request would turn a storage problem into an
      // outage.
      this.logger?.warn('dsh-codebuddy: refreshed the session but could not persist it')
      this.logger?.warn(error)
    }
    return this.identityOf(next)
  }

  /**
   * The headers every authenticated CodeBuddy request carries.
   * @returns the identity headers, with the session refreshed if needed.
   */
  async authHeaders(): Promise<Record<string, string>> {
    const identity = await this.identity()
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${identity.accessToken}`,
      'X-Domain': identity.domain,
      'X-User-Id': identity.uid,
    }
    if (identity.enterpriseId !== undefined) headers['X-Enterprise-Id'] = identity.enterpriseId
    return headers
  }

  /**
   * The CodeBuddy model catalog, cached briefly and shared between concurrent
   * readers.
   * @param signal - optional cancellation for the underlying read.
   * @returns the catalog models in service order.
   */
  async models(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]> {
    return (await this.catalogData(signal)).models
  }

  /**
   * The catalog plus its scheduled campaigns, both cached together under the
   * same TTL and single-flight as the model list.
   * @param signal - optional cancellation for the underlying read.
   * @returns the models and the campaigns in service order.
   */
  async catalogData(signal?: AbortSignal): Promise<{ models: readonly CodeBuddyModel[], promotions: readonly CodeBuddyModelPromotion[] }> {
    return this.catalogDataWith(signal, false)
  }

  /**
   * Read the catalog, optionally bypassing the TTL so a server-side edit is
   * visible immediately rather than up to five minutes later.
   *
   * `force` is what lets an explicit user action — opening the model menu, or
   * the settings page asking for the list — reflect the service's current
   * state. It is rate-limited by {@link CATALOG_FORCE_FLOOR_MS}: a forced read
   * arriving within that window of the last read returns the cached copy,
   * because the catalog cannot have meaningfully changed and each read is a
   * service round-trip.
   *
   * When a read's content differs from the previous one, every registered
   * change listener fires, which is how the plugin republishes
   * `llm/adapters-updated` and makes the client drop its cached groups.
   * @param signal - optional cancellation for the underlying read.
   * @param force - whether to bypass the cache TTL (subject to the floor).
   * @returns the models and the campaigns in service order.
   */
  private async catalogDataWith(signal: AbortSignal | undefined, force: boolean): Promise<{ models: readonly CodeBuddyModel[], promotions: readonly CodeBuddyModelPromotion[] }> {
    const cached = this.catalog
    if (cached !== undefined) {
      const age = Date.now() - cached.readAt
      if (age < CATALOG_TTL_MS && !(force && age >= CATALOG_FORCE_FLOOR_MS)) {
        return cached
      }
    }
    // Single-flight only when nothing is in flight; a forced read after a
    // settled one starts fresh rather than joining a response already stale.
    this.catalogRead ??= this.readModels(signal).finally(() => {
      this.catalogRead = undefined
    })
    return this.catalogRead
  }

  private async readModels(signal?: AbortSignal): Promise<CatalogSnapshot> {
    const identity = await this.identity()
    let config
    try {
      config = await getConfig(identity, signal)
    } catch (error) {
      // Mirror the chat path: a 401/403 means the stored token was rejected
      // outright, so drop it and let the next call re-read the file (a
      // concurrent login may have replaced it) instead of retrying a token
      // already known to be refused. Without this the catalog read would keep
      // presenting a revoked token until some chat request happened to 401.
      if (error instanceof ConfigRequestError && (error.status === 401 || error.status === 403)) {
        this.invalidate()
      }
      throw error
    }
    const models = config.models.filter(model => typeof model.id === 'string' && model.id.length > 0)
    const promotions = config.modelPromotions ?? []
    const fingerprint = catalogFingerprint(models)
    // Compared against the last read ever, not just the live cache: a login as
    // a different account clears the cache, and the catalog it replaces still
    // has to be announced so the picker stops showing the previous account's
    // models. The first read after mount is silent — there is nothing yet to
    // invalidate client-side.
    const changed = this.lastFingerprint !== undefined && this.lastFingerprint !== fingerprint
    this.lastFingerprint = fingerprint
    this.catalog = { models, promotions, readAt: Date.now(), fingerprint }
    // Announced on a microtask, never synchronously: this read's promise is
    // still the session's shared in-flight one, and a listener that reacted by
    // reading the catalog again would otherwise join a promise that cannot
    // settle until this function returns.
    if (changed) queueMicrotask(() => { this.emitCatalogChange() })
    return this.catalog
  }

  /**
   * The catalog, or an empty list when it cannot be read.
   *
   * Listing models is a browsing action on a settings page, so a failure must
   * degrade to "nothing to show" rather than break the page. The request path
   * uses {@link models} directly and keeps the real failure.
   * @param signal - optional cancellation.
   * @returns the catalog, or an empty list.
   */
  async modelsOrEmpty(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]> {
    try {
      return await this.models(signal)
    } catch (error) {
      if (error instanceof NotLoggedInError) return []
      this.logger?.warn('dsh-codebuddy: could not read the model catalog')
      this.logger?.warn(error)
      return []
    }
  }

  /**
   * The catalog and campaigns, or empty lists when they cannot be read — the
   * advisory-read twin of {@link modelsOrEmpty}.
   * @param signal - optional cancellation.
   * @returns the models and campaigns, or empty lists.
   */
  async catalogDataOrEmpty(signal?: AbortSignal): Promise<{ models: readonly CodeBuddyModel[], promotions: readonly CodeBuddyModelPromotion[] }> {
    return this.catalogDataOrEmptyWith(signal, false, false)
  }

  /**
   * Force a fresh catalog read for a user-facing surface, never throwing.
   *
   * Bypasses the TTL (subject to the floor) so an explicit action — opening the
   * model menu, or the settings page asking for the list — sees the service's
   * current catalog. Unlike {@link catalogDataOrEmpty}, a failed read returns
   * the last good copy rather than empty lists: this feeds the picker's display
   * enrichment, where a transient blip must not blank every row's tags and
   * credit multiplier down to a bare name. Only a signed-out session, or one
   * that has never read successfully, yields empty lists.
   * @param signal - optional cancellation.
   * @returns the current models and campaigns, the last good copy, or empty lists.
   */
  async refreshCatalog(signal?: AbortSignal): Promise<{ models: readonly CodeBuddyModel[], promotions: readonly CodeBuddyModelPromotion[] }> {
    return this.catalogDataOrEmptyWith(signal, true, true)
  }

  /**
   * Shared advisory read. `force` bypasses the TTL; `fallbackToLastGood`
   * decides whether a failed read serves the previous snapshot or empty lists.
   */
  private async catalogDataOrEmptyWith(signal: AbortSignal | undefined, force: boolean, fallbackToLastGood: boolean): Promise<{ models: readonly CodeBuddyModel[], promotions: readonly CodeBuddyModelPromotion[] }> {
    try {
      return await this.catalogDataWith(signal, force)
    } catch (error) {
      if (error instanceof NotLoggedInError) return { models: [], promotions: [] }
      this.logger?.warn('dsh-codebuddy: could not read the model catalog')
      this.logger?.warn(error)
      // A failed read must not blank a catalog that is still perfectly usable:
      // the previous snapshot degrades to the bare name/credit rows this plugin
      // exists to improve, so a transient blip would look like "every model
      // lost its metadata". The next successful read replaces it and announces
      // any real change.
      const cached = fallbackToLastGood ? this.catalog : undefined
      return cached ?? { models: [], promotions: [] }
    }
  }

  /**
   * The CodeBuddy usage/quota snapshot, or `undefined` when it cannot be read.
   *
   * Usage is an advisory read on a settings surface, so a meter outage must
   * degrade to "nothing to show" rather than propagate: a {@link NotLoggedInError}
   * surfaces as a signed-out state, and every other failure (transport, parse,
   * expired refresh) resolves to `undefined` after a warning. The identity is
   * resolved through the same single-flight refresh as a chat request, so a
   * concurrent meter read never spends the refresh token twice.
   * @param signal - optional cancellation.
   * @returns the snapshot, or `undefined` when nothing is stored or the meter
   *   plane was unreachable.
   */
  async usage(signal?: AbortSignal): Promise<UsageSnapshot | undefined> {
    let identity: CodeBuddyIdentity
    try {
      identity = await this.identity()
    } catch (error) {
      if (error instanceof NotLoggedInError) return undefined
      this.logger?.warn('dsh-codebuddy: could not resolve identity for usage read')
      this.logger?.warn(error)
      return undefined
    }
    return fetchUsage(identity, signal)
  }
}
