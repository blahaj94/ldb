import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { formatDate } from '../format-date.mjs'

const script = fileURLToPath(new URL('../format-date.mjs', import.meta.url))

test('formatDate rejects non-string timestamps with the existing UTC ISO error', () => {
  for (const timestamp of [null, 42, Symbol('timestamp')]) {
    assert.throws(() => formatDate(timestamp), {
      message: 'Expected a valid UTC ISO timestamp ending in Z'
    })
  }
})

test('CLI displays Korean midnight across the year boundary regardless of host time zone', () => {
  for (const timeZone of ['UTC', 'America/New_York']) {
    const result = spawnSync(process.execPath, [script, '2026-12-31T15:00:59.999Z'], {
      encoding: 'utf8',
      env: { ...process.env, TZ: timeZone }
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '2027년 1월 1일 00시 00분\n')
  }
})

test('CLI uses the current instant when no timestamp argument is supplied', () => {
  const clockSetup = `import { mock } from 'node:test';
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-08T15:35:00Z') });`
  const clockImport = `data:text/javascript,${encodeURIComponent(clockSetup)}`

  const result = spawnSync(process.execPath, ['--import', clockImport, script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '2026년 9월 9일 00시 35분\n')
})

test('CLI rejects invalid dates and a timestamp without a time zone', () => {
  for (const timestamp of ['2026-01-01T99:00:00Z', '2026-02-30T00:00:00Z', '2026-09-08T15:35:00']) {
    const result = spawnSync(process.execPath, [script, timestamp], {
      encoding: 'utf8'
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /UTC ISO/)
  }
})
