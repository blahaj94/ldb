import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('build emits the Electron main entry declared in package.json', () => {
  execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
    cwd: appDirectory,
    stdio: 'inherit'
  })

  const packageJson = JSON.parse(readFileSync(resolve(appDirectory, 'package.json'), 'utf8'))
  assert.equal(packageJson.main, './out/backend/main.js')
  assert.ok(existsSync(resolve(appDirectory, packageJson.main)))
})
