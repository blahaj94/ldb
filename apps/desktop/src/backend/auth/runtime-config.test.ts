import * as fs from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { applyAuthRuntimeProfile, readAuthRuntimeConfig } from './runtime-config'
import type { AuthRuntimeConfig, AuthRuntimeProfileApplication } from './runtime-config'

type RuntimeProfileFilesystemDouble = {
  lstatSync: typeof fs.lstatSync
  statSync: typeof fs.statSync
  mkdirSync: typeof fs.mkdirSync
  openSync(path: string, flags: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
}

const validEnvironment = {
  LDB_AUTH_API_ORIGIN: 'https://api.synthetic.test',
  LDB_AUTH_RETURN_TARGET: 'ldb-synthetic://auth/return',
  LDB_AUTH_ENVIRONMENT: 'test',
  LDB_AUTH_PROVIDERS: 'google',
  LDB_AUTH_APP_IDENTITY: 'com.synthetic.ldb',
  LDB_AUTH_USER_DATA_PATH: '/synthetic/ldb-test-profile'
}

describe('desktop auth runtime config', () => {
  it('validates a complete trusted tuple without supplying defaults', () => {
    expect(readAuthRuntimeConfig(validEnvironment)).toEqual({
      apiOrigin: 'https://api.synthetic.test',
      returnTarget: 'ldb-synthetic://auth/return',
      environment: 'test',
      providers: ['google'],
      appIdentity: 'com.synthetic.ldb',
      userDataPath: '/synthetic/ldb-test-profile'
    })
  })

  it.each([
    {},
    { ...validEnvironment, LDB_AUTH_API_ORIGIN: '' },
    { ...validEnvironment, LDB_AUTH_RETURN_TARGET: 'https://wrong.test/return' },
    { ...validEnvironment, LDB_AUTH_ENVIRONMENT: 'Test' },
    { ...validEnvironment, LDB_AUTH_PROVIDERS: 'google,google' },
    { ...validEnvironment, LDB_AUTH_PROVIDERS: 'discord' },
    { ...validEnvironment, LDB_AUTH_PROVIDERS: 'google,discord' },
    { ...validEnvironment, LDB_AUTH_PROVIDERS: 'twitter' },
    { ...validEnvironment, LDB_AUTH_APP_IDENTITY: '' },
    { ...validEnvironment, LDB_AUTH_APP_IDENTITY: '1.invalid' },
    { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: 'relative/profile' },
    { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: '/' }
  ])('rejects incomplete or invalid values without a production fallback: %j', (environment) => {
    expect(readAuthRuntimeConfig(environment)).toBeNull()
  })

  it('applies the trusted app identity and userData profile before the instance lock', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ldb-runtime-profile-'))
    const userDataPath = join(root, 'profile')
    fs.mkdirSync(userDataPath, { mode: 0o700 })
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig({
      ...validEnvironment,
      LDB_AUTH_USER_DATA_PATH: userDataPath
    })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      expect(() => applyAuthRuntimeProfile(application, config)).not.toThrow()
      expect(calls).toEqual([
        `path:userData:${userDataPath}`,
        'name:com.synthetic.ldb',
        'identity:com.synthetic.ldb'
      ])
      expect(fs.lstatSync(userDataPath).mode & 0o7777).toBe(0o700)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a missing trusted userData directory before setPath', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ldb-runtime-profile-'))
    const userDataPath = join(root, 'new-profile')
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => {
        fs.lstatSync(value)
        calls.push(`path:${name}:${value}`)
      },
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig({
      ...validEnvironment,
      LDB_AUTH_USER_DATA_PATH: userDataPath
    })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      expect(() => applyAuthRuntimeProfile(application, config)).not.toThrow()
      expect(fs.lstatSync(userDataPath).isDirectory()).toBe(true)
      expect(fs.lstatSync(userDataPath).mode & 0o7777).toBe(0o700)
      expect(calls[0]).toBe(`path:userData:${userDataPath}`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['file', 'symlink', 'permission'] as const)(
    'rejects a userData %s before changing app identity',
    (kind) => {
      const root = fs.mkdtempSync(join(tmpdir(), 'ldb-runtime-profile-'))
      const userDataPath = join(root, 'profile')
      if (kind === 'file') {
        fs.writeFileSync(userDataPath, 'synthetic')
      } else if (kind === 'symlink') {
        const target = join(root, 'target')
        fs.mkdirSync(target, { mode: 0o700 })
        fs.symlinkSync(target, userDataPath)
      } else {
        fs.mkdirSync(userDataPath, { mode: 0o755 })
      }
      const calls: string[] = []
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        setName: (value: string) => calls.push(`name:${value}`),
        setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
      }
      const config = readAuthRuntimeConfig({
        ...validEnvironment,
        LDB_AUTH_USER_DATA_PATH: userDataPath
      })

      try {
        expect(config).not.toBeNull()
        if (config == null) {
          throw new Error('Synthetic runtime config should be available')
        }

        expect(() => applyAuthRuntimeProfile(application, config)).toThrow()
        expect(calls).toEqual([])
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['trailing-separator', 'dot-alias'] as const)(
    'rejects a symlink profile with a %s leaf alias',
    (kind) => {
      const root = fs.mkdtempSync(join(tmpdir(), 'ldb-runtime-profile-'))
      const userDataPath = join(root, 'profile')
      const target = join(root, 'target')
      fs.mkdirSync(target, { mode: 0o700 })
      fs.symlinkSync(target, userDataPath)
      const aliasedPath =
        kind === 'trailing-separator' ? `${userDataPath}${sep}` : `${userDataPath}${sep}.`
      const calls: string[] = []
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        setName: (value: string) => calls.push(`name:${value}`),
        setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
      }
      const parsed = readAuthRuntimeConfig({
        ...validEnvironment,
        LDB_AUTH_USER_DATA_PATH: userDataPath
      })

      try {
        expect(parsed).not.toBeNull()
        if (parsed == null) {
          throw new Error('Synthetic runtime config should be available')
        }

        const config = { ...parsed, userDataPath: aliasedPath }
        expect(() => applyAuthRuntimeProfile(application, config)).toThrow()
        expect(calls).toEqual([])
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('syncs each newly created profile directory and its parent entry before setPath', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ldb-runtime-profile-'))
    const parent = join(root, 'nested')
    const userDataPath = join(parent, 'profile')
    const openedPaths: string[] = []
    const syncedFds: number[] = []
    const closedFds: number[] = []
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      mkdirSync: fs.mkdirSync,
      openSync: (path: string, flags: number) => {
        openedPaths.push(path)
        return fs.openSync(path, flags)
      },
      fsyncSync: (fd: number) => {
        syncedFds.push(fd)
        return fs.fsyncSync(fd)
      },
      closeSync: (fd: number) => {
        closedFds.push(fd)
        return fs.closeSync(fd)
      }
    }
    let syncCountAtSetPath = 0
    const application = {
      setPath: () => {
        syncCountAtSetPath = syncedFds.length
      },
      setName: () => undefined,
      setAppUserModelId: () => undefined
    }
    const config = readAuthRuntimeConfig({
      ...validEnvironment,
      LDB_AUTH_USER_DATA_PATH: userDataPath
    })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      const applyWithFilesystem = applyAuthRuntimeProfile as unknown as (
        application: AuthRuntimeProfileApplication,
        config: AuthRuntimeConfig,
        filesystem: RuntimeProfileFilesystemDouble
      ) => void
      applyWithFilesystem(application, config, filesystem)

      const profileOpenIndex = openedPaths.indexOf(userDataPath)
      const parentSyncIndex = openedPaths.findIndex(
        (path, index) => index > profileOpenIndex && path === parent
      )
      expect(profileOpenIndex).toBeGreaterThanOrEqual(0)
      expect(openedPaths).toContain(parent)
      expect(parentSyncIndex).toBeGreaterThan(profileOpenIndex)
      expect(syncCountAtSetPath).toBeGreaterThan(0)
      expect(syncCountAtSetPath).toBe(syncedFds.length)
      expect(closedFds.length).toBe(openedPaths.length)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
