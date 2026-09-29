/**
 * Browser/Host contract for the private CodeBuddy RPC channel.
 *
 * This module is runtime-neutral: both halves import the channel constant and
 * share these data-only request/response types without pulling Host code into
 * the browser bundle.
 */

import type { CodeBuddySiteId } from './constants.js'

/** Logical RPC channel owned by the CodeBuddy authentication service. */
export const CODEBUDDY_AUTH_CHANNEL = '/codebuddy'

/** Current CodeBuddy authentication state. */
export interface CodeBuddyAuthStatus {
  loggedIn: boolean
  expired?: boolean
  nickname?: string
  uid?: string
  uin?: string
  domain?: string
  enterpriseId?: string
  enterpriseName?: string
  enterpriseUserName?: string
  departmentFullName?: string
}

/** Browser-login handshake returned by `startLogin`. */
export interface CodeBuddyLoginStart {
  authUrl: string
  state: string
}

/** Browser-login polling result. */
export interface CodeBuddyLoginPoll {
  done: boolean
  nickname?: string
}

/** One client-safe metering window. */
export interface CodeBuddyUsageWindow {
  name: string
  used?: number
  limit?: number
  usedPercent?: number
  resetsAt?: string
}

/** Usage projection returned to the browser. */
export interface CodeBuddyUsageResult {
  loggedIn: boolean
  windows: CodeBuddyUsageWindow[]
  primary?: CodeBuddyUsageWindow
}

/** Client-facing facts for one active model promotion. */
export interface CodeBuddyPromotionView {
  color: string
  label: string
  text?: string
  discountedRate?: string
}

/** One model-catalog entry returned to the browser. */
export interface CodeBuddyModelEntry {
  id: string
  name: string
  credits?: string
  tags?: string[]
  description?: string
  promotion?: CodeBuddyPromotionView
}

/** Model-catalog projection returned to the browser. */
export interface CodeBuddyModelsResult {
  loggedIn: boolean
  models: CodeBuddyModelEntry[]
}

/** Request and response types for every endpoint on the private channel. */
export interface CodeBuddyRpcMap {
  status: { request: Record<string, never>, response: CodeBuddyAuthStatus }
  startLogin: { request: { site: CodeBuddySiteId }, response: CodeBuddyLoginStart }
  pollLogin: { request: { state: string }, response: CodeBuddyLoginPoll }
  logout: { request: Record<string, never>, response: void }
  usage: { request: Record<string, never>, response: CodeBuddyUsageResult }
  models: { request: Record<string, never>, response: CodeBuddyModelsResult }
  locale: { request: string, response: null }
}

export type CodeBuddyRpcEndpoint = keyof CodeBuddyRpcMap
export type CodeBuddyRpcRequest<K extends CodeBuddyRpcEndpoint> = CodeBuddyRpcMap[K]['request']
export type CodeBuddyRpcResponse<K extends CodeBuddyRpcEndpoint> = CodeBuddyRpcMap[K]['response']
