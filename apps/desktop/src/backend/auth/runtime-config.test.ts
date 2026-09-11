import { describe, expect, it } from 'vitest'
import { applyAuthRuntimeProfile, readAuthRuntimeConfig } from './runtime-config'

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
    const calls: string[] = []
    const application = {
      setPath: (name: 'userData', value: string) => calls.push(`path:${name}:${value}`),
      setName: (value: string) => calls.push(`name:${value}`),
      setAppUserModelId: (value: string) => calls.push(`identity:${value}`)
    }
    const config = readAuthRuntimeConfig(validEnvironment)

    expect(config).not.toBeNull()
    if (config == null) {
      throw new Error('Synthetic runtime config should be available')
    }

    expect(() => applyAuthRuntimeProfile(application, config)).not.toThrow()
    expect(calls).toEqual([
      'path:userData:/synthetic/ldb-test-profile',
      'name:com.synthetic.ldb',
      'identity:com.synthetic.ldb'
    ])
  })
})
