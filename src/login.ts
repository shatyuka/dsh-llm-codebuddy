/**
 * The browser-OAuth login flow, start to persisted credential.
 *
 * No API key is ever asked for: the handshake mints a `state`, the user signs
 * in in a normal browser, and the tokens are polled out of the service against
 * that state. The only thing the user does is click through a login page.
 *
 * @module dsh-llm-codebuddy/login
 */

import { spawn } from 'node:child_process'
import { getLoginAccount, pollAuthToken, requestAuthState } from './codebuddy.js'
import { saveStorage } from './storage.js'
import type { Account, AuthToken } from './types.js'
import type { CodeBuddyStorage } from './storage.js'

/** What a completed login produced. */
export interface LoginResult {
  storage: CodeBuddyStorage
  nickname: string
}

/**
 * Build the durable credential from freshly issued tokens and the account
 * facts.
 *
 * Shared by the CLI flow and the Web auth service so the two cannot drift on
 * the storage shape: both write exactly this object.
 * @param token - tokens issued once the browser login completed.
 * @param account - the signed-in account the tokens were issued for.
 * @returns the credential to persist.
 */
export function buildStorage(token: AuthToken, account: Account): CodeBuddyStorage {
  return {
    auth: {
      accessToken: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1000,
      refreshToken: token.refreshToken,
      refreshExpiresAt: Date.now() + token.refreshExpiresIn * 1000,
      domain: token.domain,
    },
    account: {
      uid: account.uid,
      nickname: account.nickname,
      ...account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId },
      ...account.enterpriseName === undefined ? {} : { enterpriseName: account.enterpriseName },
      ...account.enterpriseUserName === undefined ? {} : { enterpriseUserName: account.enterpriseUserName },
      ...account.departmentFullName === undefined
        ? {}
        : { departmentFullName: account.departmentFullName },
    },
  }
}

/** Hooks the caller supplies to drive the flow's user interaction. */
export interface LoginHooks {
  /** Called with the URL the user must open. */
  onUrl?: (url: string) => void
  /** Whether to try opening the browser automatically. */
  openBrowser?: boolean
}

/**
 * Open a URL in the user's default browser, best effort.
 *
 * A failure is deliberately silent: the URL has already been printed, so a
 * headless or locked-down environment still has a working path forward, and a
 * spawn error would otherwise read as a login failure.
 */
function openInBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // Printed URL is the fallback.
    })
    child.unref()
  } catch {
    // Printed URL is the fallback.
  }
}

/**
 * Run the whole browser-login flow.
 * @param hooks - user-interaction hooks.
 * @param signal - optional cancellation.
 * @returns the persisted credential and the signed-in nickname.
 * @throws Error when the handshake fails, the user does not finish in time, or
 *   the account cannot be read.
 */
export async function login(hooks: LoginHooks = {}, signal?: AbortSignal): Promise<LoginResult> {
  const state = await requestAuthState(signal)
  hooks.onUrl?.(state.authUrl)
  if (hooks.openBrowser !== false) openInBrowser(state.authUrl)

  const token = await pollAuthToken(state.state, signal)
  if (token === undefined) {
    throw new Error('CodeBuddy sign-in did not complete (it was refused, or it timed out).')
  }

  const account = await getLoginAccount(state.state, token.accessToken, token.domain)

  const storage = buildStorage(token, account)
  await saveStorage(storage)
  return { storage, nickname: account.nickname }
}
