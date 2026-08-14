#!/usr/bin/env node
/**
 * `dsh-codebuddy-login`: sign in to CodeBuddy through the browser, then write
 * the credential where the plugin reads it.
 *
 * Deliberately a separate entry point rather than an in-harness prompt: the
 * flow needs a browser and a human, and a running agent must not block a model
 * call waiting for one. A harness already running picks the credential up on
 * its next request without a restart.
 *
 * Usage:
 *   dsh-codebuddy-login           sign in
 *   dsh-codebuddy-login --status  show who is signed in
 *   dsh-codebuddy-login --logout  remove the stored credential
 *   dsh-codebuddy-login --no-open print the URL without opening a browser
 *
 * @module dsh-llm-codebuddy/cli/login
 */

import { login } from '../login.js'
import { hasDisclosedCapacity } from '../types.js'
import { CodeBuddySession } from '../session.js'
import { clearStorage, getStoragePath, loadStorage } from '../storage.js'

async function status(): Promise<number> {
  const stored = await loadStorage()
  if (stored === undefined) {
    console.log('Not signed in. Run `dsh-codebuddy-login` to sign in through your browser.')
    return 1
  }
  console.log(`Signed in as ${stored.account.nickname} (uid ${stored.account.uid})`)
  console.log(`Credential: ${getStoragePath()}`)
  console.log(`Access token expires:  ${new Date(stored.auth.expiresAt).toLocaleString()}`)
  console.log(`Refresh token expires: ${new Date(stored.auth.refreshExpiresAt).toLocaleString()}`)
  const session = new CodeBuddySession()
  const models = await session.modelsOrEmpty()
  if (models.length === 0) {
    console.log('Models: none readable (the session may need refreshing)')
    return 0
  }
  console.log(`Models (${models.length}):`)
  for (const model of models) {
    const label = model.credits === undefined ? model.name : `${model.name} [${model.credits}]`
    const flags = [
      model.supportsToolCall === true ? 'tools' : undefined,
      model.supportsReasoning === true ? 'reasoning' : undefined,
      model.supportsImages === true ? 'images' : undefined,
      // This listing stays a full view of the catalog, so entries the harness
      // does not offer are marked rather than hidden — otherwise the command
      // could not explain why a model is missing from the picker.
      hasDisclosedCapacity(model) ? undefined : 'no size, not offered',
    ].filter(Boolean).join(', ')
    console.log(`  ${model.id}  ${label}${flags.length > 0 ? `  (${flags})` : ''}`)
  }
  return 0
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2))

  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: dsh-codebuddy-login [--status | --logout | --no-open]')
    return 0
  }
  if (args.has('--status')) return status()
  if (args.has('--logout')) {
    await clearStorage()
    console.log('Signed out; the stored CodeBuddy credential was removed.')
    return 0
  }

  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    const result = await login(
      {
        openBrowser: !args.has('--no-open'),
        onUrl: (url) => {
          console.log('Open this URL to sign in to CodeBuddy:')
          console.log(`  ${url}`)
          console.log('Waiting for the browser sign-in to complete...')
        },
      },
      controller.signal,
    )
    console.log(`Signed in as ${result.nickname}.`)
    console.log(`Credential written to ${getStoragePath()}`)
    return 0
  } catch (error) {
    console.error(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

main().then((code) => {
  process.exitCode = code
}).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
