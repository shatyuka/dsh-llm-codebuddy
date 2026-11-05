/**
 * Transport binding for the plugin's Remote endpoints.
 *
 * @module dsh-llm-codebuddy/client/bind
 */

import type { ClientConnectionRpc, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CodeBuddyRpcEndpoint,
  CodeBuddyRpcRequest,
  CodeBuddyRpcResponse,
} from '../protocol.js'

/** Typed view over the transport for this plugin's endpoint map. */
export interface CodeBuddyRpc {
  call: <K extends CodeBuddyRpcEndpoint>(
    endpoint: K,
    payload: CodeBuddyRpcRequest<K>,
    signal?: AbortSignal,
  ) => Promise<ConnectionRpcResult<CodeBuddyRpcResponse<K>>>
}

/**
 * Bind the endpoint map to the Gateway channel.
 *
 * The Gateway reads a call's arguments from a lone `args` field.
 * @param rpc - the Connection RPC face (`ctx.connection.rpc`).
 * @returns the typed caller over this plugin's endpoints.
 */
export function bindCodeBuddyRpc(rpc: ClientConnectionRpc): CodeBuddyRpc {
  return {
    call: <K extends CodeBuddyRpcEndpoint>(endpoint: K, payload: CodeBuddyRpcRequest<K>, signal?: AbortSignal) =>
      rpc.call('/api', `codebuddy/${endpoint}`, { args: payload }, signal) as
        Promise<ConnectionRpcResult<CodeBuddyRpcResponse<K>>>,
  }
}
