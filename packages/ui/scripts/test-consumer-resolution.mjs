import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, test } from 'node:test'
import { stopOwnedProcessGroup } from './consumer-process-lifecycle.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))

// 전용 checkout에서 직렬 실행한다. 이전 case의 output/cache로 cold 실패를 가리지 않는다.
beforeEach(() => {
  for (const path of [
    'packages/ui/dist',
    'packages/ui/dist-examples',
    'apps/web/dist',
    'apps/desktop/out',
    'packages/ui/node_modules/.vite',
    'apps/web/node_modules/.vite',
    'apps/desktop/node_modules/.vite',
    'apps/web/node_modules/.tmp'
  ]) {
    rmSync(new URL(`../../../${path}`, import.meta.url), { recursive: true, force: true })
  }
})

for (const [workspace, command] of [
  ['@ldb/web', 'test'],
  ['@ldb/web', 'typecheck'],
  ['@ldb/web', 'build'],
  ['@ldb/desktop', 'test'],
  ['@ldb/desktop', 'typecheck'],
  ['@ldb/desktop', 'build'],
  ['@ldb/ui', 'test'],
  ['@ldb/ui', 'typecheck'],
  ['@ldb/ui', 'build:examples']
]) {
  test(`cold pnpm --filter ${workspace} ${command}`, () => {
    const result = spawnSync('pnpm', ['--filter', workspace, command], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    })

    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })
}

for (const { name, executable, args, cwd, entries } of [
  {
    name: 'pnpm --filter @ldb/web dev',
    executable: 'pnpm',
    args: ['--filter', '@ldb/web', 'dev', '--host', '127.0.0.1', '--port', '0'],
    cwd: root,
    entries: ['/src/main.tsx', '/src/App.tsx']
  },
  {
    name: 'pnpm --filter @ldb/ui dev:examples',
    executable: 'pnpm',
    args: ['--filter', '@ldb/ui', 'dev:examples', '--host', '127.0.0.1', '--port', '0'],
    cwd: root,
    entries: ['/main.tsx']
  },
  {
    name: 'Desktop dev renderer config without Electron bootstrap',
    executable: 'node',
    args: ['scripts/ui-renderer-resolution.mjs'],
    cwd: new URL('../../../apps/desktop/', import.meta.url),
    entries: ['/src/main.tsx', '/src/App.tsx']
  }
]) {
  test(`cold ${name} resolves browser entries`, async () => {
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    })
    let output = ''
    const appendOutput = (chunk) => {
      output += chunk.toString()
    }
    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    const exited = once(child, 'exit')
    let timeout
    let inspectionFailure = {}

    try {
      const origin = await Promise.race([
        new Promise((resolve) => {
          child.stdout.on('data', () => {
            const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//)
            const hasAddress = match != null
            if (hasAddress) {
              resolve(match[0])
            }
          })
        }),
        exited.then(() => {
          throw new Error(`Dev command exited before ready:\n${output}`)
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Dev startup timeout:\n${output}`)), 30_000)
        })
      ])

      for (const entry of entries) {
        const response = await fetch(new URL(entry, origin), {
          signal: AbortSignal.timeout(30_000)
        })
        const source = await response.text()
        assert.equal(response.status, 200, `${entry}\n${output}`)
        assert.match(source, /import /, `Expected transformed module: ${entry}`)
      }
    } catch (error) {
      inspectionFailure = { originalError: error }
      throw error
    } finally {
      clearTimeout(timeout)
      await stopOwnedProcessGroup({ child, exited, ...inspectionFailure })
    }
  })
}
