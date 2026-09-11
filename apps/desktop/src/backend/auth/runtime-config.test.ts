import * as fs from 'node:fs'
import { dirname, join, posix, sep, win32 } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  applyAuthRuntimeProfile,
  AuthRuntimeProfileApplicationFailure,
  readAuthRuntimeConfig
} from './runtime-config'
import type { AuthRuntimeConfig, AuthRuntimeProfileApplication } from './runtime-config'

type RuntimeProfileFilesystemDouble = {
  lstatSync: typeof fs.lstatSync
  statSync: typeof fs.statSync
  realpathSync(path: string): string
  mkdirSync(path: string, options: { mode: number }): void
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

function createRuntimeProfileRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(homedir(), '.ldb-runtime-profile-')))
  fs.chmodSync(root, 0o700)
  return root
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

  it.each([
    'LDB_AUTH_API_ORIGIN',
    'LDB_AUTH_RETURN_TARGET',
    'LDB_AUTH_ENVIRONMENT',
    'LDB_AUTH_PROVIDERS',
    'LDB_AUTH_APP_IDENTITY',
    'LDB_AUTH_USER_DATA_PATH'
  ] as const)('rejects a trusted tuple missing required key %s', (missingKey) => {
    const environment: Record<string, string | undefined> = { ...validEnvironment }
    delete environment[missingKey]

    expect(readAuthRuntimeConfig(environment)).toBeNull()
  })

  it('rejects non-native separators under Windows path semantics', () => {
    const readWithPathSemantics = readAuthRuntimeConfig as unknown as (
      environment: Record<string, string | undefined>,
      pathSemantics: typeof win32
    ) => AuthRuntimeConfig | null
    const nativePath = String.raw`C:\Users\Alice\LdbProfile`
    const separatorAliases = [
      'C:/Users/Alice/LdbProfile',
      String.raw`C:/Users\Alice\LdbProfile`,
      String.raw`C:\Users/Alice\LdbProfile`
    ]

    expect(
      readWithPathSemantics({ ...validEnvironment, LDB_AUTH_USER_DATA_PATH: nativePath }, win32)
    ).toMatchObject({ userDataPath: nativePath })
    for (const separatorAlias of separatorAliases) {
      expect(
        readWithPathSemantics(
          { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: separatorAlias },
          win32
        )
      ).toBeNull()
    }
  })

  it('rejects repeated separators absorbed into a Windows UNC root', () => {
    const readWithPathSemantics = readAuthRuntimeConfig as unknown as (
      environment: Record<string, string | undefined>,
      pathSemantics: typeof win32
    ) => AuthRuntimeConfig | null
    const nativePath = String.raw`\\server\share\LdbProfile`
    const separatorAlias = String.raw`\\server\\share\LdbProfile`

    expect(
      readWithPathSemantics({ ...validEnvironment, LDB_AUTH_USER_DATA_PATH: nativePath }, win32)
    ).toMatchObject({ userDataPath: nativePath })
    expect(
      readWithPathSemantics({ ...validEnvironment, LDB_AUTH_USER_DATA_PATH: separatorAlias }, win32)
    ).toBeNull()
  })

  it.each([
    ['separator', 'C:/Users/Alice/LdbProfile'],
    ['trailing-dot', String.raw`C:\Users\Alice\LdbProfile.`],
    ['trailing-space', String.raw`C:\Users\Alice\LdbProfile `]
  ] as const)(
    'rejects a Windows %s alias before touching the profile filesystem',
    (_kind, path) => {
      const touchedPaths: string[] = []
      const calls: string[] = []
      const rejectFilesystemAccess = (operation: string, target: fs.PathLike | number): never => {
        touchedPaths.push(`${operation}:${String(target)}`)
        throw new Error('Synthetic filesystem access')
      }
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        getPath: () => path,
        setName: (value: string) => calls.push(`name:${value}`),
        setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
      }
      const filesystem: RuntimeProfileFilesystemDouble = {
        lstatSync: ((path: fs.PathLike) =>
          rejectFilesystemAccess('lstat', path)) as typeof fs.lstatSync,
        statSync: ((path: fs.PathLike) =>
          rejectFilesystemAccess('stat', path)) as typeof fs.statSync,
        realpathSync: (path) => rejectFilesystemAccess('realpath', path),
        mkdirSync: (path) => rejectFilesystemAccess('mkdir', path),
        openSync: (path) => rejectFilesystemAccess('open', path),
        fsyncSync: (fd) => rejectFilesystemAccess('fsync', fd),
        closeSync: (fd) => rejectFilesystemAccess('close', fd)
      }
      const config: AuthRuntimeConfig = {
        apiOrigin: validEnvironment.LDB_AUTH_API_ORIGIN,
        returnTarget: validEnvironment.LDB_AUTH_RETURN_TARGET,
        environment: validEnvironment.LDB_AUTH_ENVIRONMENT,
        providers: ['google'],
        appIdentity: validEnvironment.LDB_AUTH_APP_IDENTITY,
        userDataPath: path
      }

      const applyWithPathSemantics = applyAuthRuntimeProfile as unknown as (
        application: AuthRuntimeProfileApplication,
        config: AuthRuntimeConfig,
        filesystem: RuntimeProfileFilesystemDouble,
        pathSemantics: typeof win32
      ) => void
      expect(() => applyWithPathSemantics(application, config, filesystem, win32)).toThrow()
      expect(touchedPaths).toEqual([])
      expect(calls).toEqual([])
    }
  )

  it.each([
    String.raw`C:\Users\Alice\LdbProfile.`,
    String.raw`C:\Users\Alice\LdbProfile `,
    String.raw`C:\Users.\Alice\LdbProfile`,
    String.raw`\\server\share\LdbProfile.`
  ])('rejects a Windows path with a Win32-normalized segment before apply: %s', (path) => {
    const readWithPathSemantics = readAuthRuntimeConfig as unknown as (
      environment: Record<string, string | undefined>,
      pathSemantics: typeof win32
    ) => AuthRuntimeConfig | null

    expect(
      readWithPathSemantics({ ...validEnvironment, LDB_AUTH_USER_DATA_PATH: path }, win32)
    ).toBeNull()
  })

  it('applies the trusted app identity and userData profile before the instance lock', () => {
    const root = createRuntimeProfileRoot()
    const userDataPath = join(root, 'profile')
    fs.mkdirSync(userDataPath, { mode: 0o700 })
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
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

  it.each(['setName', 'setAppUserModelId'] as const)(
    'classifies an Electron %s failure after setPath as a fatal partial application',
    (failurePoint) => {
      const root = createRuntimeProfileRoot()
      const userDataPath = join(root, 'profile')
      fs.mkdirSync(userDataPath, { mode: 0o700 })
      const calls: string[] = []
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        getPath: () => userDataPath,
        setName: (value: string) => {
          calls.push(`name:${value}`)
          if (failurePoint === 'setName') {
            throw new Error('Synthetic identity failure')
          }
        },
        setAppUserModelId: (value: string) => {
          calls.push(`identity:${value}`)
          if (failurePoint === 'setAppUserModelId') {
            throw new Error('Synthetic identity failure')
          }
        }
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

        expect(() => applyAuthRuntimeProfile(application, config)).toThrow(
          AuthRuntimeProfileApplicationFailure
        )
        const expectedCalls =
          failurePoint === 'setName'
            ? [`path:userData:${userDataPath}`, 'name:com.synthetic.ldb']
            : [
                `path:userData:${userDataPath}`,
                'name:com.synthetic.ldb',
                'identity:com.synthetic.ldb'
              ]
        expect(calls).toEqual(expectedCalls)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('classifies an Electron userData readback mismatch as a fatal partial application', () => {
    const root = createRuntimeProfileRoot()
    const userDataPath = join(root, 'profile')
    const otherUserDataPath = join(root, 'other-profile')
    fs.mkdirSync(userDataPath, { mode: 0o700 })
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: (name: 'userData') => {
        calls.push(`get-path:${name}`)
        return otherUserDataPath
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

      expect(() => applyAuthRuntimeProfile(application, config)).toThrow(
        AuthRuntimeProfileApplicationFailure
      )
      expect(calls).toEqual([`path:userData:${userDataPath}`, 'get-path:userData'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a missing trusted userData directory before setPath', () => {
    const root = createRuntimeProfileRoot()
    const userDataPath = join(root, 'new-profile')
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => {
        fs.lstatSync(value)
        calls.push(`path:${name}:${value}`)
      },
      getPath: () => userDataPath,
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

  it('revalidates a userData directory created by a concurrent first launch', () => {
    const root = createRuntimeProfileRoot()
    const userDataPath = join(root, 'new-profile')
    const calls: string[] = []
    const openedPaths: string[] = []
    const syncedFds: number[] = []
    let openedPathsAtSetPath: string[] = []
    let syncCountAtSetPath = 0
    const application = {
      setPath: (name: 'userData', value: string) => {
        openedPathsAtSetPath = [...openedPaths]
        syncCountAtSetPath = syncedFds.length
        calls.push(`path:${name}:${value}`)
      },
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: fs.realpathSync.native,
      mkdirSync: (path, options) => {
        fs.mkdirSync(path, options)
        throw Object.assign(new Error('Synthetic concurrent creation'), { code: 'EEXIST' })
      },
      openSync: (path: string, flags: number) => {
        openedPaths.push(path)
        return fs.openSync(path, flags)
      },
      fsyncSync: (fd: number) => {
        syncedFds.push(fd)
        return fs.fsyncSync(fd)
      },
      closeSync: fs.closeSync
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
      expect(() => applyWithFilesystem(application, config, filesystem)).not.toThrow()
      expect(calls).toEqual([
        `path:userData:${userDataPath}`,
        'name:com.synthetic.ldb',
        'identity:com.synthetic.ldb'
      ])
      expect(openedPathsAtSetPath).toEqual(
        expect.arrayContaining([userDataPath, root, dirname(root)])
      )
      expect(syncCountAtSetPath).toBe(openedPathsAtSetPath.length)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a canonical alias created by a concurrent first launch before syncing', () => {
    const root = createRuntimeProfileRoot()
    const userDataPath = join(root, 'new-profile')
    const canonicalUserDataPath = join(root, 'New-Profile')
    const calls: string[] = []
    const openedPaths: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) =>
        path === userDataPath ? canonicalUserDataPath : fs.realpathSync.native(path),
      mkdirSync: (path, options) => {
        fs.mkdirSync(path, options)
        throw Object.assign(new Error('Synthetic concurrent creation'), { code: 'EEXIST' })
      },
      openSync: (path, flags) => {
        openedPaths.push(path)
        return fs.openSync(path, flags)
      },
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync
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
      expect(() => applyWithFilesystem(application, config, filesystem)).toThrow()
      expect(openedPaths).toEqual([])
      expect(calls).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['mode 0755', 0o755, 0],
    ['foreign POSIX uid', 0o700, 1]
  ] as const)(
    'rejects a concurrent-created final profile with %s before setters',
    (_condition, mode, uidOffset) => {
      const root = createRuntimeProfileRoot()
      const userDataPath = join(root, 'new-profile')
      const currentUid = 1_000
      const calls: string[] = []
      const mkdirPaths: string[] = []
      let finalPathReads = 0
      const concurrentStat = {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: currentUid + uidOffset,
        mode
      } as fs.Stats
      const trustedAncestorStat = {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: currentUid,
        mode: 0o700
      } as fs.Stats
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        getPath: () => userDataPath,
        setName: (value: string) => calls.push(`name:${value}`),
        setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
      }
      const filesystem: RuntimeProfileFilesystemDouble = {
        lstatSync: ((path: fs.PathLike) => {
          if (String(path) !== userDataPath) {
            return trustedAncestorStat
          }
          finalPathReads += 1
          if (finalPathReads === 1) {
            throw Object.assign(new Error('Synthetic missing profile'), { code: 'ENOENT' })
          }
          return concurrentStat
        }) as typeof fs.lstatSync,
        statSync: fs.statSync,
        realpathSync: fs.realpathSync.native,
        mkdirSync: (path) => {
          mkdirPaths.push(path)
          throw Object.assign(new Error('Synthetic concurrent creation'), { code: 'EEXIST' })
        },
        openSync: () => {
          throw new Error('Invalid concurrent profile must not be synced')
        },
        fsyncSync: () => undefined,
        closeSync: () => undefined
      }
      const config = readAuthRuntimeConfig({
        ...validEnvironment,
        LDB_AUTH_USER_DATA_PATH: userDataPath
      })
      const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid')
      Object.defineProperty(process, 'getuid', { configurable: true, value: () => currentUid })

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
        expect(() => applyWithFilesystem(application, config, filesystem)).toThrow()
        expect(finalPathReads).toBe(2)
        expect(mkdirPaths).toEqual([userDataPath])
        expect(calls).toEqual([])
      } finally {
        if (originalGetUid == null) {
          Reflect.deleteProperty(process, 'getuid')
        } else {
          Object.defineProperty(process, 'getuid', originalGetUid)
        }
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['file', 'symlink', 'permission'] as const)(
    'rejects a userData %s before changing app identity',
    (kind) => {
      const root = createRuntimeProfileRoot()
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
        getPath: () => userDataPath,
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

  it('rejects a profile owned by a different POSIX uid before changing app identity', () => {
    const currentUid = 1_000
    const userDataPath = '/synthetic/profile'
    const directoryStat = (uid: number): fs.Stats =>
      ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid,
        mode: 0o700
      }) as fs.Stats
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: ((path: fs.PathLike) =>
        directoryStat(
          String(path) === userDataPath ? currentUid + 1 : currentUid
        )) as typeof fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) => path,
      mkdirSync: () => undefined,
      openSync: () => 1,
      fsyncSync: () => undefined,
      closeSync: () => undefined
    }
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig(
      { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: userDataPath },
      posix
    )
    const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid')
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => currentUid })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }
      const applyWithPathSemantics = applyAuthRuntimeProfile as unknown as (
        application: AuthRuntimeProfileApplication,
        config: AuthRuntimeConfig,
        filesystem: RuntimeProfileFilesystemDouble,
        pathSemantics: typeof posix
      ) => void

      expect(() => applyWithPathSemantics(application, config, filesystem, posix)).toThrow()
      expect(calls).toEqual([])
    } finally {
      if (originalGetUid == null) {
        Reflect.deleteProperty(process, 'getuid')
      } else {
        Object.defineProperty(process, 'getuid', originalGetUid)
      }
    }
  })

  it('rejects a group-writable existing ancestor before applying the profile', () => {
    const root = createRuntimeProfileRoot()
    const parent = join(root, 'shared')
    const userDataPath = join(parent, 'profile')
    fs.mkdirSync(parent, { mode: 0o700 })
    fs.mkdirSync(userDataPath, { mode: 0o700 })
    fs.chmodSync(parent, 0o770)
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
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
  })

  it('rejects a foreign-owned existing ancestor before applying the profile', () => {
    const currentUid = 1_000
    const userDataPath = '/synthetic/unsafe/profile'
    const directoryStat = (uid: number): fs.Stats =>
      ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid,
        mode: 0o700
      }) as fs.Stats
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: ((path: fs.PathLike) => {
        const resolvedPath = String(path)
        const uid = resolvedPath === '/synthetic/unsafe' ? currentUid + 1 : currentUid
        return directoryStat(uid)
      }) as typeof fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) => path,
      mkdirSync: () => undefined,
      openSync: () => 1,
      fsyncSync: () => undefined,
      closeSync: () => undefined
    }
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig(
      { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: userDataPath },
      posix
    )
    const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid')
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => currentUid })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      const applyWithPathSemantics = applyAuthRuntimeProfile as unknown as (
        application: AuthRuntimeProfileApplication,
        config: AuthRuntimeConfig,
        filesystem: RuntimeProfileFilesystemDouble,
        pathSemantics: typeof posix
      ) => void
      expect(() => applyWithPathSemantics(application, config, filesystem, posix)).toThrow()
      expect(calls).toEqual([])
    } finally {
      if (originalGetUid == null) {
        Reflect.deleteProperty(process, 'getuid')
      } else {
        Object.defineProperty(process, 'getuid', originalGetUid)
      }
    }
  })

  it('rejects an unsafe filesystem root before applying an existing profile', () => {
    const currentUid = 1_000
    const userDataPath = '/synthetic/profile'
    const safeDirectoryStat = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: currentUid,
      mode: 0o700
    } as fs.Stats
    const unsafeRootStat = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o777
    } as fs.Stats
    const openedPaths: string[] = []
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: ((path: fs.PathLike) =>
        String(path) === '/' ? unsafeRootStat : safeDirectoryStat) as typeof fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) => path,
      mkdirSync: () => {
        throw new Error('Unsafe root must be rejected before mkdir')
      },
      openSync: (path) => {
        openedPaths.push(String(path))
        return 1
      },
      fsyncSync: () => undefined,
      closeSync: () => undefined
    }
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig(
      { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: userDataPath },
      posix
    )
    const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid')
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => currentUid })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      const applyWithPathSemantics = applyAuthRuntimeProfile as unknown as (
        application: AuthRuntimeProfileApplication,
        config: AuthRuntimeConfig,
        filesystem: RuntimeProfileFilesystemDouble,
        pathSemantics: typeof posix
      ) => void
      expect(() => applyWithPathSemantics(application, config, filesystem, posix)).toThrow()
      expect(openedPaths).toEqual([])
      expect(calls).toEqual([])
    } finally {
      if (originalGetUid == null) {
        Reflect.deleteProperty(process, 'getuid')
      } else {
        Object.defineProperty(process, 'getuid', originalGetUid)
      }
    }
  })

  it('rejects an unsafe filesystem root before creating a missing descendant', () => {
    const currentUid = 1_000
    const userDataPath = '/synthetic/new-profile/profile'
    const safeDirectoryStat = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: currentUid,
      mode: 0o700
    } as fs.Stats
    const unsafeRootStat = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 0,
      mode: 0o777
    } as fs.Stats
    const mkdirPaths: string[] = []
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: ((path: fs.PathLike) => {
        if (String(path) === '/') {
          return unsafeRootStat
        }
        if (String(path) === '/synthetic') {
          return safeDirectoryStat
        }
        throw Object.assign(new Error('Synthetic missing path'), { code: 'ENOENT' })
      }) as typeof fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) => path,
      mkdirSync: (path) => {
        mkdirPaths.push(path)
      },
      openSync: () => 1,
      fsyncSync: () => undefined,
      closeSync: () => undefined
    }
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig(
      { ...validEnvironment, LDB_AUTH_USER_DATA_PATH: userDataPath },
      posix
    )
    const originalGetUid = Object.getOwnPropertyDescriptor(process, 'getuid')
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => currentUid })

    try {
      expect(config).not.toBeNull()
      if (config == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      const applyWithPathSemantics = applyAuthRuntimeProfile as unknown as (
        application: AuthRuntimeProfileApplication,
        config: AuthRuntimeConfig,
        filesystem: RuntimeProfileFilesystemDouble,
        pathSemantics: typeof posix
      ) => void
      expect(() => applyWithPathSemantics(application, config, filesystem, posix)).toThrow()
      expect(mkdirPaths).toEqual([])
      expect(calls).toEqual([])
    } finally {
      if (originalGetUid == null) {
        Reflect.deleteProperty(process, 'getuid')
      } else {
        Object.defineProperty(process, 'getuid', originalGetUid)
      }
    }
  })

  it('rejects a symlink above the direct profile parent', () => {
    const root = createRuntimeProfileRoot()
    const target = join(root, 'target')
    const nested = join(target, 'nested')
    const profile = join(nested, 'profile')
    const alias = join(root, 'profile-alias')
    const userDataPath = join(alias, 'nested', 'profile')
    fs.mkdirSync(target, { mode: 0o700 })
    fs.mkdirSync(nested, { mode: 0o700 })
    fs.mkdirSync(profile, { mode: 0o700 })
    fs.symlinkSync(target, alias)
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
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
  })

  it('rejects a profile path whose native canonical spelling differs', () => {
    const root = createRuntimeProfileRoot()
    const parent = join(root, 'profiles')
    const userDataPath = join(parent, 'dev')
    const canonicalUserDataPath = join(root, 'Profiles', 'Dev')
    fs.mkdirSync(parent, { mode: 0o700 })
    fs.mkdirSync(userDataPath, { mode: 0o700 })
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) =>
        path === userDataPath ? canonicalUserDataPath : fs.realpathSync(path),
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync
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
      expect(() => applyWithFilesystem(application, config, filesystem)).toThrow()
      expect(calls).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a missing profile below a parent whose canonical spelling differs', () => {
    const root = createRuntimeProfileRoot()
    const parent = join(root, 'profiles')
    const userDataPath = join(parent, 'dev')
    const canonicalParent = join(root, 'Profiles')
    fs.mkdirSync(parent, { mode: 0o700 })
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) => (path === parent ? canonicalParent : fs.realpathSync(path)),
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync
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
      expect(() => applyWithFilesystem(application, config, filesystem)).toThrow()
      expect(fs.existsSync(userDataPath)).toBe(false)
      expect(calls).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['trailing-separator', 'dot-alias'] as const)(
    'rejects a symlink profile with a %s leaf alias',
    (kind) => {
      const root = createRuntimeProfileRoot()
      const userDataPath = join(root, 'profile')
      const target = join(root, 'target')
      fs.mkdirSync(target, { mode: 0o700 })
      fs.symlinkSync(target, userDataPath)
      const aliasedPath =
        kind === 'trailing-separator' ? `${userDataPath}${sep}` : `${userDataPath}${sep}.`
      const calls: string[] = []
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        getPath: () => aliasedPath,
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

  it.each([
    ['current-directory', '.'],
    ['parent-directory', '..'],
    ['empty', '']
  ] as const)('rejects a %s segment before touching the profile filesystem', (_kind, segment) => {
    const root = createRuntimeProfileRoot()
    const child = join(root, 'child')
    fs.mkdirSync(child, { mode: 0o700 })
    const aliasedPath = `${child}${sep}${segment}${sep}profile`
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => aliasedPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const parsed = readAuthRuntimeConfig({
      ...validEnvironment,
      LDB_AUTH_USER_DATA_PATH: join(root, 'valid-profile')
    })

    try {
      expect(parsed).not.toBeNull()
      if (parsed == null) {
        throw new Error('Synthetic runtime config should be available')
      }

      expect(
        readAuthRuntimeConfig({
          ...validEnvironment,
          LDB_AUTH_USER_DATA_PATH: aliasedPath
        })
      ).toBeNull()
      const config: AuthRuntimeConfig = { ...parsed, userDataPath: aliasedPath }
      expect(() => applyAuthRuntimeProfile(application, config)).toThrow()
      expect(calls).toEqual([])
      expect(fs.existsSync(join(root, 'profile'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses POSIX path semantics so backslashes remain part of the profile name', () => {
    const root = '/synthetic'
    const userDataPath = posix.join(root, 'profile\\name')
    const existingPaths = new Set(['/', root])
    const createdPaths: string[] = []
    const directoryStat = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: process.getuid?.() ?? 0,
      mode: 0o700
    } as fs.Stats
    const lstatSync = ((path: fs.PathLike) => {
      const resolvedPath = String(path)
      if (!existingPaths.has(resolvedPath)) {
        throw Object.assign(new Error('Synthetic missing path'), { code: 'ENOENT' })
      }

      return directoryStat
    }) as typeof fs.lstatSync
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync,
      statSync: fs.statSync,
      realpathSync: (path) => path,
      mkdirSync: (path) => {
        existingPaths.add(path)
        createdPaths.push(path)
      },
      openSync: () => 1,
      fsyncSync: () => undefined,
      closeSync: () => undefined
    }
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => {
        calls.push(`path:${name}:${value}`)
      },
      getPath: () => userDataPath,
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig(
      {
        ...validEnvironment,
        LDB_AUTH_USER_DATA_PATH: userDataPath
      },
      posix
    )

    expect(config).not.toBeNull()
    if (config == null) {
      throw new Error('Synthetic runtime config should be available')
    }

    const applyWithPathSemantics = applyAuthRuntimeProfile as unknown as (
      application: AuthRuntimeProfileApplication,
      config: AuthRuntimeConfig,
      filesystem: RuntimeProfileFilesystemDouble,
      pathSemantics: typeof posix
    ) => void
    expect(() => applyWithPathSemantics(application, config, filesystem, posix)).not.toThrow()
    expect(createdPaths).toEqual([userDataPath])
    expect(calls[0]).toBe(`path:userData:${userDataPath}`)
  })

  it('syncs each newly created profile directory and its parent entry before setPath', () => {
    const root = createRuntimeProfileRoot()
    const parent = join(root, 'nested')
    const userDataPath = join(parent, 'profile')
    const openedPaths: string[] = []
    const syncedFds: number[] = []
    const closedFds: number[] = []
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: fs.realpathSync.native,
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
      getPath: () => userDataPath,
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

  it('repairs an observed concurrent parent entry before applying its missing profile child', () => {
    const root = createRuntimeProfileRoot()
    const observedParent = join(root, 'observed')
    const parent = join(observedParent, 'nested')
    const userDataPath = join(parent, 'profile')
    fs.mkdirSync(observedParent, { mode: 0o700 })
    const openedPaths: string[] = []
    let openedPathsAtProfileApplication: string[] = []
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: fs.realpathSync.native,
      mkdirSync: fs.mkdirSync,
      openSync: (path, flags) => {
        openedPaths.push(path)
        return fs.openSync(path, flags)
      },
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync
    }
    const application = {
      setPath: () => {
        openedPathsAtProfileApplication = [...openedPaths]
      },
      getPath: () => userDataPath,
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
      ) => AuthRuntimeConfig
      applyWithFilesystem(application, config, filesystem)

      expect(openedPathsAtProfileApplication).toContain(observedParent)
      expect(openedPathsAtProfileApplication).toContain(root)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('syncs an existing profile directory and its parent before setPath', () => {
    const root = createRuntimeProfileRoot()
    const userDataPath = join(root, 'profile')
    fs.mkdirSync(userDataPath, { mode: 0o700 })
    const openedPaths: string[] = []
    const syncedFds: number[] = []
    const filesystem: RuntimeProfileFilesystemDouble = {
      lstatSync: fs.lstatSync,
      statSync: fs.statSync,
      realpathSync: fs.realpathSync.native,
      mkdirSync: fs.mkdirSync,
      openSync: (path: string, flags: number) => {
        openedPaths.push(path)
        return fs.openSync(path, flags)
      },
      fsyncSync: (fd: number) => {
        syncedFds.push(fd)
        return fs.fsyncSync(fd)
      },
      closeSync: fs.closeSync
    }
    let syncCountAtSetPath = 0
    const application = {
      setPath: () => {
        syncCountAtSetPath = syncedFds.length
      },
      getPath: () => userDataPath,
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

      expect(openedPaths).toEqual([userDataPath, root])
      expect(syncCountAtSetPath).toBe(2)
      expect(syncCountAtSetPath).toBe(syncedFds.length)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['open', 'fsync'] as const)(
    'does not apply the profile when existing-directory %s durability fails',
    (failurePoint) => {
      const root = createRuntimeProfileRoot()
      const userDataPath = join(root, 'profile')
      fs.mkdirSync(userDataPath, { mode: 0o700 })
      const calls: string[] = []
      const filesystem: RuntimeProfileFilesystemDouble = {
        lstatSync: fs.lstatSync,
        statSync: fs.statSync,
        realpathSync: fs.realpathSync.native,
        mkdirSync: fs.mkdirSync,
        openSync: (path: string, flags: number) => {
          if (failurePoint === 'open') {
            throw new Error('Synthetic directory open failure')
          }
          return fs.openSync(path, flags)
        },
        fsyncSync: (fd: number) => {
          if (failurePoint === 'fsync') {
            throw new Error('Synthetic directory sync failure')
          }
          return fs.fsyncSync(fd)
        },
        closeSync: fs.closeSync
      }
      const application = {
        setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
        getPath: () => userDataPath,
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
        const applyWithFilesystem = applyAuthRuntimeProfile as unknown as (
          application: AuthRuntimeProfileApplication,
          config: AuthRuntimeConfig,
          filesystem: RuntimeProfileFilesystemDouble
        ) => void

        expect(() => applyWithFilesystem(application, config, filesystem)).toThrow()
        expect(calls).toEqual([])
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects a direct symlink parent before creating the profile directory', () => {
    const root = createRuntimeProfileRoot()
    const target = join(root, 'target')
    const parent = join(root, 'parent')
    const userDataPath = join(parent, 'profile')
    fs.mkdirSync(target, { mode: 0o700 })
    fs.symlinkSync(target, parent)
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      getPath: () => userDataPath,
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
      expect(fs.existsSync(join(target, 'profile'))).toBe(false)
      expect(calls).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
