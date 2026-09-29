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
 *   dsh-codebuddy-login                 sign in to the default site (cn)
 *   dsh-codebuddy-login --site intl     sign in to the international site
 *   dsh-codebuddy-login --status        show who is signed in
 *   dsh-codebuddy-login --logout        remove the stored credential
 *   dsh-codebuddy-login --no-open       print the URL without opening a browser
 *
 * @module dsh-llm-codebuddy/cli/login
 */

import { login } from '../login.js'
import { hasDisclosedCapacity } from '../types.js'
import { CodeBuddySession } from '../session.js'
import { clearStorage, getStoragePath, loadStorage } from '../storage.js'
import { CODEBUDDY_SITES, DEFAULT_SITE_ID, endpointOf, isSiteId } from '../constants.js'
import type { CodeBuddySiteId } from '../constants.js'

/**
 * The bare host of a site, for the banners below.
 * @param site - the site id.
 * @returns the host.
 */
function siteHost(site: CodeBuddySiteId): string {
  return new URL(endpointOf(site)).host
}

/**
 * Read `--site <id>` or `--site=<id>` from the argument list.
 * @param args - the raw arguments.
 * @returns the requested site, or the default when the flag is absent.
 * @throws Error when the flag is malformed or names an unknown site.
 */
function siteArg(args: readonly string[]): CodeBuddySiteId {
  const equals = args.find(arg => arg.startsWith('--site='))
  if (equals !== undefined) {
    return siteOrThrow(equals.slice('--site='.length))
  }
  const index = args.indexOf('--site')
  if (index < 0) return DEFAULT_SITE_ID
  return siteOrThrow(args[index + 1])
}

/**
 * Validate a site named by an explicit flag.
 * @param value - the candidate, which may be absent or another flag.
 * @returns the named site.
 * @throws Error naming the known sites, so a typo names its fix.
 */
function siteOrThrow(value: string | undefined): CodeBuddySiteId {
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`--site needs a value; known sites: ${Object.keys(CODEBUDDY_SITES).join(', ')}`)
  }
  if (!isSiteId(value)) {
    throw new Error(`unknown site ${JSON.stringify(value)}; known sites: ${Object.keys(CODEBUDDY_SITES).join(', ')}`)
  }
  return value
}

async function status(): Promise<number> {
  const stored = await loadStorage()
  if (stored === undefined) {
    console.log('Not signed in. Run `dsh-codebuddy-login` to sign in through your browser.')
    return 1
  }
  console.log(`Signed in as ${stored.account.nickname} (uid ${stored.account.uid})`)
  console.log(`Site: ${siteHost(stored.site)} (${stored.site})`)
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

/**
 * The `--help` text.
 * @returns the help text.
 */
function helpText(): string {
  const sites = Object.keys(CODEBUDDY_SITES) as CodeBuddySiteId[]
  const width = Math.max(...sites.map(site => site.length))
  const rows = sites.map(site =>
    `    ${site.padEnd(width)}  ${siteHost(site)}${site === DEFAULT_SITE_ID ? ' (default)' : ''}`)
  return [
    'Usage: dsh-codebuddy-login [--site <id>] [--status | --logout | --no-open]',
    '',
    '  --site <id>  site to sign in to:',
    ...rows,
    '  --status     show the signed-in account, its site, and the model list',
    '  --logout     remove the stored credential',
    '  --no-open    print the sign-in URL without opening a browser',
  ].join('\n')
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const args = new Set(argv)

  if (args.has('--help') || args.has('-h')) {
    console.log(helpText())
    return 0
  }
  if (args.has('--status')) return status()
  if (args.has('--logout')) {
    await clearStorage()
    console.log('Signed out; the stored CodeBuddy credential was removed.')
    return 0
  }

  let site: CodeBuddySiteId
  try {
    site = siteArg(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    const result = await login(
      {
        site,
        openBrowser: !args.has('--no-open'),
        onUrl: (url) => {
          console.log(`Open this URL to sign in to CodeBuddy (${siteHost(site)}):`)
          console.log(`  ${url}`)
          console.log('Waiting for the browser sign-in to complete...')
        },
      },
      controller.signal,
    )
    console.log(`Signed in as ${result.nickname} on ${siteHost(site)}.`)
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
