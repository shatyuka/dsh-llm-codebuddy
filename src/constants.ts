/**
 * Fixed CodeBuddy service facts.
 *
 * These are protocol constants rather than user configuration: the endpoint is
 * where the OAuth handshake and the model catalog both live, and the version
 * strings are what the service expects a plugin client to identify itself as.
 *
 * @module dsh-llm-codebuddy/constants
 */

/** The provider route this plugin registers on `ctx.llm`. */
export const CODEBUDDY_PROVIDER = 'codebuddy'

/** Display name shown in model selectors and settings surfaces. */
export const CODEBUDDY_DISPLAY_NAME = 'CodeBuddy'

/**
 * The CodeBuddy deployments this plugin can sign in to, by service root.
 *
 * The two hosts run the same service but hold *separate accounts*, so the
 * site is picked at sign-in and recorded with the credential.
 */
export const CODEBUDDY_SITES = {
  cn: 'https://copilot.tencent.com',
  intl: 'https://www.codebuddy.ai',
} as const

/** One of the deployments in {@link CODEBUDDY_SITES}. */
export type CodeBuddySiteId = keyof typeof CODEBUDDY_SITES

/** The site assumed when a credential does not name one. */
export const DEFAULT_SITE_ID: CodeBuddySiteId = 'cn'

/**
 * Whether a value names a known site.
 *
 * Site ids arrive from disk and over RPC, so an unknown one is possible.
 * @param value - the candidate site id.
 * @returns true when the value is a known site id.
 */
export function isSiteId(value: unknown): value is CodeBuddySiteId {
  return typeof value === 'string' && Object.hasOwn(CODEBUDDY_SITES, value)
}

/**
 * Resolve a value to a usable site, falling back to {@link DEFAULT_SITE_ID}.
 * @param value - the candidate site id.
 * @returns the value when known, otherwise the default site.
 */
export function resolveSite(value: unknown): CodeBuddySiteId {
  return isSiteId(value) ? value : DEFAULT_SITE_ID
}

/**
 * The service root for a site.
 * @param site - the site id.
 * @returns the endpoint origin, with no trailing slash.
 */
export function endpointOf(site: CodeBuddySiteId): string {
  return CODEBUDDY_SITES[site]
}

/** Version this client reports to the service. */
export const CODEBUDDY_IDE_VERSION = '4.12.0'

/** The user-agent this client reports on the chat and meter planes. */
export const CODEBUDDY_IDE_USER_AGENT = `CodeBuddyIDE/${CODEBUDDY_IDE_VERSION}`

/** The WorkBuddy product's user-agent, for the international catalog read. */
export const WORKBUDDY_USER_AGENT = 'WorkBuddy/5.7.2 CLI/2.156.0'

/**
 * The user-agent the catalog read reports.
 *
 * `/v3/config` keys its listing per product name: the international host
 * serves its full list only to the CLI agent, every other context keeps the
 * IDE agent.
 * @param site - the site id.
 * @returns the `User-Agent` header value for the catalog read.
 */
export function catalogUserAgentOf(site: CodeBuddySiteId): string {
  return site === 'intl' ? WORKBUDDY_USER_AGENT : CODEBUDDY_IDE_USER_AGENT
}

/**
 * Context capacity assumed for a model the catalog does not describe at all.
 *
 * This is a convention, not a CodeBuddy-provided figure: the service discloses
 * `maxAllowedSize` per model and offers no global default to fall back on.
 * Listed models are therefore never sized from this — an entry that withholds
 * its capacity is dropped from the listing instead. It applies only to an id
 * named explicitly that the catalog does not list, where something must be
 * assumed to resolve the route at all.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Output cap assumed for an unlisted model; a convention, as above. */
export const DEFAULT_MAX_TOKENS = 8_192

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** How long the browser login flow waits for the user to finish, in ms. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Poll interval while waiting for the browser login to complete, in ms. */
export const LOGIN_POLL_INTERVAL_MS = 1_000

/** Browser login not finished. */
export const CODE_AUTH_PENDING = 11217

/** No quota available. */
export const CODE_NO_QUOTA = 14018

/** No team quota available. */
export const CODE_NO_TEAM_QUOTA = 14019
