import { app, safeStorage } from 'electron'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { strict as assert } from 'node:assert'
import { createMacOsCredentialStore } from '../../src/backend/auth/credential-store/macos-credential-store'
import { clearCredential } from '../../src/backend/auth/credential-operations'
import type { CredentialTransitionKind } from '../../src/backend/auth/types'

const appName = process.env.LDB_CREDENTIAL_NATIVE_NAME ?? ''
const profile = process.env.LDB_CREDENTIAL_NATIVE_PROFILE ?? ''
const phase = process.env.LDB_CREDENTIAL_NATIVE_PHASE ?? ''
const hasTestName = /^LDB-Credential-Test-[0-9a-f-]{36}$/.test(appName)
const hasAbsoluteProfile = isAbsolute(profile)
const hasValidInput = hasTestName && hasAbsoluteProfile
if (!hasValidInput) {
  app.exit(1)
}

// Electron/Chromium의 Keychain service/account 초기화보다 먼저 고유 시험 identity를 고정한다.
app.setName(appName)
app.setPath('userData', profile)
app.disableHardwareAcceleration()

const context = {
  environment: 'test',
  apiOrigin: 'https://credential-native.example.test',
  clientId: 'desktop'
} as const
const refresh0 = Buffer.alloc(32, 41).toString('base64url')
const refresh1 = Buffer.alloc(32, 42).toString('base64url')
let decryptCalls = 0
let encryptionAvailabilityCalls = 0

async function run(): Promise<void> {
  await app.whenReady()
  assert.equal(process.platform, 'darwin')
  assert.equal(process.versions.electron, '39.8.10')
  assert.equal(process.versions.node, '22.22.1')
  assert.equal(process.versions.uv, '1.51.0')
  const store = createMacOsCredentialStore({
    userDataPath: profile,
    context,
    safeStorage: {
      isEncryptionAvailable: () => {
        encryptionAvailabilityCalls += 1
        return safeStorage.isEncryptionAvailable()
      },
      encryptString: (plaintext) => safeStorage.encryptString(plaintext),
      decryptString: (ciphertext) => {
        decryptCalls += 1
        return safeStorage.decryptString(ciphertext)
      }
    }
  })

  async function persist(refreshToken: string, kind: CredentialTransitionKind): Promise<void> {
    assert.equal(await store.establishTransition(kind), 'confirmed')
    assert.equal(await store.commitCredential(refreshToken), 'confirmed')
    assert.equal(await store.removeTransition(), 'confirmed')
  }

  switch (phase) {
    case 'write':
      assert.deepEqual(await store.inspect(), { status: 'empty' })
      await persist(refresh0, 'exchange')
      break
    case 'restart':
      assert.deepEqual(await store.inspect(), { status: 'ready', refreshToken: refresh0 })
      await persist(refresh1, 'refresh')
      assert.deepEqual(await store.inspect(), { status: 'ready', refreshToken: refresh1 })
      assert.deepEqual(await readdir(join(profile, 'auth', 'test')), ['credential.v1'])
      break
    case 'mark':
      assert.deepEqual(await store.inspect(), { status: 'ready', refreshToken: refresh1 })
      assert.equal(await store.establishTransition('refresh'), 'confirmed')
      break
    case 'recover':
      assert.deepEqual(await store.inspect(), { status: 'recovery-required' })
      assert.equal(decryptCalls, 0)
      assert.equal(encryptionAvailabilityCalls, 0)
      assert.equal(await clearCredential(store), 'cleared')
      assert.deepEqual(await readdir(join(profile, 'auth', 'test')), [])
      break
    default:
      throw new Error('Unknown native credential test phase.')
  }
}

void run().then(
  () => {
    const result = { phase, ok: true, decryptCalls, encryptionAvailabilityCalls }
    process.stdout.write(`LDB_CREDENTIAL_NATIVE:${JSON.stringify(result)}\n`, () => app.exit(0))
  },
  () => {
    // Native/OS 오류 원문·plaintext·ciphertext·profile은 출력하지 않는다.
    process.stdout.write(`LDB_CREDENTIAL_NATIVE:${JSON.stringify({ phase, ok: false })}\n`, () =>
      app.exit(1)
    )
  }
)
