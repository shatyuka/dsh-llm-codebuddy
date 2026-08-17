/**
 * Durable OAuth token storage, owner-only on disk.
 *
 * The store lives in the harness home (`$DSH_HOME`, resolved via the same
 * `@deepseek-ai/dsh-home-paths` the harness uses) rather than in the plugin
 * package, so a reinstall does not sign the user out. Writes are atomic
 * (write-temp-then-rename) because the login CLI and a running harness can
 * both write: a torn file would strand the user with an unreadable credential
 * and no way to tell that from "never logged in".
 *
 * @module dsh-llm-codebuddy/storage
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The persisted shape; `auth` and `account` are always written together. */
export interface CodeBuddyStorage {
  auth: {
    accessToken: string
    /** Absolute expiry in epoch ms. */
    expiresAt: number
    refreshToken: string
    /** Absolute refresh-token expiry in epoch ms. */
    refreshExpiresAt: number
    domain: string
  }
  account: {
    uid: string
    nickname: string
    /** Tencent user identity number (e.g. QQ openid), when the account discloses one. */
    uin?: string
    enterpriseId?: string
    /** Enterprise display name, when the account is an enterprise tenant. */
    enterpriseName?: string
    /** Enterprise user name (the account's name within the tenant). */
    enterpriseUserName?: string
    departmentFullName?: string
  }
}

/**
 * Absolute path of the credential file.
 *
 * Resolved through `@deepseek-ai/dsh-home-paths` so it tracks the harness's
 * own home precedence (configured path > `$DSH_HOME` > `~/.dsh`) and never
 * diverges into a separately-computed home. `DSH_CODEBUDDY_AUTH_FILE`
 * remains as an explicit escape hatch for tests and relocations.
 */
export function getStoragePath(): string {
  const override = process.env.DSH_CODEBUDDY_AUTH_FILE
  if (override !== undefined && override.length > 0) return override
  return dshHomePath('codebuddy-auth.json')
}

/**
 * Whether a path is readable by its owner only.
 *
 * Mirrors the owner-only check `@deepseek-ai/dsh-credentials-local` makes
 * before loading its own credential document: any group or other read/write
 * bit set means the file is exposed, and the check fails. Windows has no
 * POSIX mode, so the check is skipped there — protection is whatever the
 * create and replace APIs expressed, as on dsh-credentials-local.
 * @param path - the credential file path.
 * @returns true when the file is absent (nothing to protect yet) or exists
 *   with owner-only permission; false when it exists and is exposed.
 */
async function isOwnerOnly(path: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  let mode: number
  try {
    mode = (await fs.stat(path)).mode
  } catch {
    // Absent is not an exposure; the caller treats it as "no credential".
    return true
  }
  // 0o077 = group + other read/write/execute bits.
  return (mode & 0o077) === 0
}

/**
 * Read the stored credential.
 *
 * Before any byte is read, the file's mode is checked: a credential that
 * other users on the host could read is treated as absent rather than used,
 * so a file that lost its owner-only mode (a bad manual chmod, a copy from
 * elsewhere) is never loaded. Treating it as absent also self-heals — the
 * next login rewrites the file with `0o600`.
 * @returns the credential, or `undefined` when absent or unusable. A missing
 *   file, a corrupt one, and an insecurely-permissioned one are deliberately
 *   the same answer: all mean "there is nothing safe here to authenticate
 *   with", and the login flow is the fix for each.
 */
export async function loadStorage(): Promise<CodeBuddyStorage | undefined> {
  const path = getStoragePath()
  try {
    if (!(await isOwnerOnly(path))) return undefined
    const raw = await fs.readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as CodeBuddyStorage | null
    if (parsed?.auth?.accessToken === undefined) return undefined
    if (parsed.account?.uid === undefined) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Write the credential atomically with owner-only permissions.
 * @param storage - the credential to persist.
 */
export async function saveStorage(storage: CodeBuddyStorage): Promise<void> {
  const path = getStoragePath()
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(storage, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(temp, path)
  } catch (error) {
    await fs.unlink(temp).catch(() => {
      // The write already failed; a missing temp file adds no information.
    })
    throw error
  }
  await fs.chmod(path, 0o600).catch(() => {
    // Filesystems without POSIX modes (Windows, some network mounts) cannot
    // narrow permissions; the credential is still written.
  })
}

/** Remove the stored credential, if any. */
export async function clearStorage(): Promise<void> {
  await fs.unlink(getStoragePath()).catch(() => {
    // Already absent is the desired end state.
  })
}
