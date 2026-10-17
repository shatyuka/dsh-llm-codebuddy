import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearStorage,
  getStoragePath,
  loadStorage,
  saveStorage,
} from '../src/storage.js'
import type { CodeBuddyStorage } from '../src/storage.js'

let home: string
let credentialPath: string

/** A complete credential, with any field overridable per test. */
function credential(over: Partial<CodeBuddyStorage> = {}): CodeBuddyStorage {
  return {
    site: 'cn',
    auth: {
      accessToken: 'access-1',
      expiresAt: 1_700_000_000_000,
      refreshToken: 'refresh-1',
      refreshExpiresAt: 1_700_100_000_000,
      domain: 'corp.example',
    },
    account: { uid: 'uid-1', nickname: 'Nick' },
    ...over,
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codebuddy-storage-'))
  credentialPath = join(home, 'nested', 'codebuddy-auth.json')
  // The escape hatch exists precisely so tests and relocations can point the
  // store somewhere else; set it before any call reads the path.
  process.env['DSH_CODEBUDDY_AUTH_FILE'] = credentialPath
})

afterEach(async () => {
  delete process.env['DSH_CODEBUDDY_AUTH_FILE']
  await rm(home, { recursive: true, force: true })
})

describe('getStoragePath', () => {
  it('honors the explicit override', () => {
    expect(getStoragePath()).toBe(credentialPath)
  })

  it('ignores an empty override so an unset variable is not "root"', () => {
    process.env['DSH_CODEBUDDY_AUTH_FILE'] = ''
    expect(getStoragePath()).not.toBe('')
    expect(getStoragePath()).toContain('codebuddy-auth.json')
  })
})

describe('saveStorage / loadStorage', () => {
  it('round-trips a credential', async () => {
    const original = credential()
    await saveStorage(original)
    await expect(loadStorage()).resolves.toEqual(original)
  })

  it('round-trips the enterprise account fields', async () => {
    const original = credential({
      site: 'intl',
      account: {
        uid: 'uid-2',
        nickname: 'Corporate Nick',
        uin: '12345',
        enterpriseId: 'ent-9',
        enterpriseName: 'Example Corp',
        enterpriseUserName: 'nick.corp',
        departmentFullName: 'R&D/Platform',
      },
    })
    await saveStorage(original)
    await expect(loadStorage()).resolves.toEqual(original)
  })

  it('creates the containing directory', async () => {
    await saveStorage(credential())
    await expect(stat(credentialPath)).resolves.toBeDefined()
  })

  it('writes owner-only permissions and no temp file is left behind', async () => {
    await saveStorage(credential())
    const stats = await stat(credentialPath)
    expect(stats.mode & 0o777).toBe(0o600)
    const leftovers = (await readdir(join(home, 'nested'))).filter(name => name !== 'codebuddy-auth.json')
    expect(leftovers).toEqual([])
  })

  it('writes indented JSON, not a single line', async () => {
    await saveStorage(credential())
    const raw = await readFile(credentialPath, 'utf-8')
    expect(raw).toContain('\n  "auth"')
    expect(JSON.parse(raw)).toMatchObject({ site: 'cn' })
  })

  it('replaces an existing credential atomically', async () => {
    await saveStorage(credential())
    const next = credential({ account: { uid: 'uid-2', nickname: 'Second' } })
    await saveStorage(next)
    await expect(loadStorage()).resolves.toEqual(next)
  })

  it('leaves the existing credential intact when the new write fails', async () => {
    // The write is temp-then-rename, so a failed save must not touch the file
    // that is already on disk. Writing in place would unlink the live
    // credential on failure and strand the user with no way to tell that from
    // "never logged in".
    await saveStorage(credential())
    const before = await readFile(credentialPath, 'utf-8')

    // Fail the temp write by making its directory read-only for this attempt.
    const directory = join(home, 'nested')
    await chmod(directory, 0o500)
    try {
      await expect(saveStorage(credential({ account: { uid: 'uid-2', nickname: 'Second' } })))
        .rejects.toBeDefined()
    } finally {
      await chmod(directory, 0o700)
    }

    await expect(readFile(credentialPath, 'utf-8')).resolves.toBe(before)
    await expect(loadStorage()).resolves.toEqual(credential())
  })
})

describe('loadStorage — rejected files', () => {
  it('reports absence when nothing was ever written', async () => {
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('reports absence for a group- or world-readable file', async () => {
    // A credential another host user could read is treated as absent: the
    // next login rewrites it owner-only, which is the self-healing remedy.
    await saveStorage(credential())
    await chmod(credentialPath, 0o644)
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('reports absence for a group-readable file', async () => {
    await saveStorage(credential())
    await chmod(credentialPath, 0o640)
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('reports absence for corrupt JSON rather than throwing', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    await writeFile(credentialPath, '{ not json', { mode: 0o600 })
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('reports absence for a document missing the access token', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    const broken = { ...credential(), auth: { domain: 'd' } }
    await writeFile(credentialPath, JSON.stringify(broken), { mode: 0o600 })
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('reports absence for a document missing the account uid', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    const broken = { ...credential(), account: { nickname: 'no uid' } }
    await writeFile(credentialPath, JSON.stringify(broken), { mode: 0o600 })
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('reports absence for a JSON null document', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    await writeFile(credentialPath, 'null', { mode: 0o600 })
    await expect(loadStorage()).resolves.toBeUndefined()
  })
})

describe('loadStorage — normalization', () => {
  it('defaults the site of a credential written before sites existed', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    const legacy = credential()
    const { site: _site, ...withoutSite } = legacy
    await writeFile(credentialPath, JSON.stringify(withoutSite), { mode: 0o600 })
    const loaded = await loadStorage()
    expect(loaded?.site).toBe('cn')
  })

  it('resolves an unknown site to the default', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    await writeFile(credentialPath, JSON.stringify({ ...credential(), site: 'mars' }), { mode: 0o600 })
    await expect(loadStorage()).resolves.toMatchObject({ site: 'cn' })
  })

  it('trims empty optional account fields so no surface renders a blank row', async () => {
    // Older credentials can carry `uin: ""` from the wire; every consumer
    // tests `=== undefined`, so the load is where that is normalized.
    await mkdir(join(home, 'nested'), { recursive: true })
    await writeFile(credentialPath, JSON.stringify({
      ...credential(),
      account: { uid: 'u', nickname: 'N', uin: '', enterpriseId: '', enterpriseName: '', enterpriseUserName: '', departmentFullName: '' },
    }), { mode: 0o600 })

    const loaded = await loadStorage()
    expect(loaded?.account).toEqual({ uid: 'u', nickname: 'N' })
  })

  it('keeps the non-empty optional fields while trimming the empty ones', async () => {
    await mkdir(join(home, 'nested'), { recursive: true })
    await writeFile(credentialPath, JSON.stringify({
      ...credential(),
      account: { uid: 'u', nickname: 'N', uin: '', enterpriseId: 'ent' },
    }), { mode: 0o600 })
    await expect(loadStorage()).resolves.toMatchObject({ account: { uid: 'u', nickname: 'N', enterpriseId: 'ent' } })
  })
})

describe('clearStorage', () => {
  it('removes the stored credential', async () => {
    await saveStorage(credential())
    await clearStorage()
    await expect(loadStorage()).resolves.toBeUndefined()
  })

  it('treats an already-absent file as the desired end state', async () => {
    await expect(clearStorage()).resolves.toBeUndefined()
    await expect(clearStorage()).resolves.toBeUndefined()
  })
})
