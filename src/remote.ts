/**
 * The Host's CodeBuddy endpoints, served by the Gateway under `/api`.
 *
 * @module dsh-llm-codebuddy/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CodeBuddySiteId } from './constants.js'
import type { MessageLocale } from './locale.js'
import type { CodeBuddyService } from './service.js'
import type {
  CodeBuddyAuthStatus,
  CodeBuddyLoginPoll,
  CodeBuddyLoginStart,
  CodeBuddyModelsResult,
  CodeBuddyUsageResult,
} from './protocol.js'

/** Cordis service key; the wire namespace defaults to it. */
export const CODEBUDDY_SERVICE = 'codebuddy'

/**
 * Thin delegates: the wire contract lives in `protocol.ts`, the logic in
 * `CodeBuddyService`.
 */
export class CodeBuddyRemote extends TypertRemoteService {
  static inject = ['typert']

  constructor(
    ctx: Context,
    private readonly service: CodeBuddyService,
    private readonly locale?: MessageLocale,
  ) {
    super(ctx, CODEBUDDY_SERVICE)
  }

  /** Read the stored credential without requiring one. */
  @Remote
  status(): Promise<CodeBuddyAuthStatus> {
    return this.service.status()
  }

  /** Mint one browser-login handshake for the selected site. */
  @Remote
  startLogin(site: CodeBuddySiteId): Promise<CodeBuddyLoginStart> {
    return this.service.startLogin(site)
  }

  /** Follow one handshake until it commits or is abandoned. */
  @Remote
  pollLogin(state: string): Promise<CodeBuddyLoginPoll> {
    return this.service.pollLogin(state)
  }

  /** Release one handshake the user abandoned before it commits. */
  @Remote
  cancelLogin(state: string): Promise<void> {
    return this.service.cancelLogin(state)
  }

  /** Cancel every in-flight handshake, then clear the stored credential. */
  @Remote
  logout(): Promise<void> {
    return this.service.logout()
  }

  /** Read the metering windows of the signed-in account. */
  @Remote
  usage(): Promise<CodeBuddyUsageResult> {
    return this.service.usage()
  }

  /** Read the model catalog the enrichment view renders. */
  @Remote
  models(): Promise<CodeBuddyModelsResult> {
    return this.service.models()
  }

  /** Record the language the browser is displaying. */
  @Remote
  reportLocale(tag: string): Promise<void> {
    this.locale?.report(tag)
    return Promise.resolve()
  }
}
