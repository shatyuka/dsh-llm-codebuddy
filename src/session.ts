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

import { getConfig, refreshAccessToken } from './codebuddy.js'
import type { CodeBuddyIdentity } from './codebuddy.js'
import { loadStorage, saveStorage } from './storage.js'
import type { CodeBuddyStorage } from './storage.js'
import type { CodeBuddyModel } from './types.js'

/** Refresh this long before the recorded expiry rather than exactly at it. */
const REFRESH_SKEW_MS = 60_000

/** How long a read catalog is reused before the service is asked again. */
const CATALOG_TTL_MS = 5 * 60 * 1000

/** Raised when nothing is signed in; carries the remedy in its message. */
export class NotLoggedInError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'NotLoggedInError'
  }
}

/** A logger surface compatible with cordis's, so the session can be used bare. */
export interface SessionLogger {
  warn: (message: unknown) => void
  error: (message: unknown) => void
}

/**
 * Owns the stored credential for one plugin instance.
 *
 * The credential is re-read from disk when absent from memory, which is what
 * lets `dsh-codebuddy-login` sign a *running* harness in without a restart.
 */
export class CodeBuddySession {
  private storage: CodeBuddyStorage | undefined
  private refreshing: Promise<CodeBuddyIdentity> | undefined
  private catalog: { models: readonly CodeBuddyModel[], readAt: number } | undefined
  private catalogRead: Promise<readonly CodeBuddyModel[]> | undefined

  constructor(private readonly logger?: SessionLogger) {}

  /** Forget the in-memory credential and catalog, forcing a re-read from disk. */
  invalidate(): void {
    this.storage = undefined
    this.catalog = undefined
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
    this.storage ??= await loadStorage()
    if (this.storage === undefined) {
      throw new NotLoggedInError(
        'CodeBuddy is not signed in. Run `npx dsh-codebuddy-login` (or `npm run login` in this'
        + ' plugin) to sign in through your browser; no API key is required.',
      )
    }
    return this.storage
  }

  /** Whether a credential exists at all, without requiring one. */
  async isLoggedIn(): Promise<boolean> {
    this.storage ??= await loadStorage()
    return this.storage !== undefined
  }

  /** The signed-in nickname, when a credential exists. */
  async nickname(): Promise<string | undefined> {
    this.storage ??= await loadStorage()
    return this.storage?.account.nickname
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
        'The CodeBuddy session has expired. Run `npx dsh-codebuddy-login` to sign in again'
        + ' through your browser.',
      )
    }
    this.refreshing ??= this.refresh(storage).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async refresh(storage: CodeBuddyStorage): Promise<CodeBuddyIdentity> {
    const refreshed = await refreshAccessToken(this.identityOf(storage), storage.auth.refreshToken)
    if (refreshed === undefined) {
      throw new NotLoggedInError(
        'Refreshing the CodeBuddy session failed. Run `npx dsh-codebuddy-login` to sign in again'
        + ' through your browser.',
      )
    }
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
    const cached = this.catalog
    if (cached !== undefined && Date.now() - cached.readAt < CATALOG_TTL_MS) {
      return cached.models
    }
    this.catalogRead ??= this.readModels(signal).finally(() => {
      this.catalogRead = undefined
    })
    return this.catalogRead
  }

  private async readModels(signal?: AbortSignal): Promise<readonly CodeBuddyModel[]> {
    const identity = await this.identity()
    const config = await getConfig(identity, signal)
    const models = config.models.filter(model => typeof model.id === 'string' && model.id.length > 0)
    this.catalog = { models, readAt: Date.now() }
    return models
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
}
