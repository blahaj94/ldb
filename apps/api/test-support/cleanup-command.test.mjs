import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { test } from 'node:test'
import { URL } from 'node:url'

const load = () => import('../dist/auth/cleanup/command.js')

for (const stage of ['success', 'factory', 'initialize', 'cleanup', 'destroy', 'partial initialize']) {
  test(`one-shot owns and closes connections: ${stage}`, async () => {
    const { runAuthenticationCleanup } = await load()
    const calls = []
    const fail = () => { throw new Error('fixture-private SQL detail') }
    const source = {
      isInitialized: false,
      initialize: async () => {
        calls.push('initialize')
        const hasPartialFailure = stage === 'partial initialize'
        const hasInitializeFailure = stage === 'initialize'
        if (hasPartialFailure || hasInitializeFailure) fail()
        source.isInitialized = true
      },
      query: async () => {
        const shouldFail = stage === 'cleanup'
        if (shouldFail) fail()
        return []
      },
      destroy: async () => {
        calls.push('destroy')
        const shouldFail = stage === 'destroy'
        if (shouldFail) fail()
        source.isInitialized = false
      },
      driver: { disconnect: async () => { calls.push('disconnect') } },
    }
    const run = runAuthenticationCleanup(() => {
      calls.push('factory')
      const shouldFail = stage === 'factory'
      if (shouldFail) fail()
      return source
    })
    const isSuccess = stage === 'success'
    if (isSuccess) assert.deepEqual(await run, { sessionsDeleted: 0, loginRequestsDeleted: 0 })
    else await assert.rejects(run, (error) => {
      assert.equal(error.message, 'Authentication cleanup failed')
      assert.equal(error.stack, 'Error: Authentication cleanup failed')
      assert.equal(error.cause, undefined)
      return true
    })
    const failedBeforeSource = stage === 'factory'
    const failedBeforeInitialized = stage === 'initialize' || stage === 'partial initialize'
    if (failedBeforeSource) assert.deepEqual(calls, ['factory'])
    else if (failedBeforeInitialized) assert.deepEqual(calls, ['factory', 'initialize', 'disconnect'])
    else assert.deepEqual(calls, ['factory', 'initialize', 'destroy'])
  })
}

test('compiled command rejects absent DB configuration without exposing values or stack', () => {
  const result = spawnSync(process.execPath, ['--import', 'reflect-metadata', 'dist/auth/cleanup/cli.js'], {
    cwd: new URL('..', import.meta.url), env: {}, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Authentication cleanup failed\n')
})

test('explicit cleanup script uses existing compiled ESM build', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts['auth:cleanup'], 'pnpm run build && node --import reflect-metadata dist/auth/cleanup/cli.js')
})
