import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { instrument } from './login-test-control.mjs'
import { digest, fixture, rejected, stored } from './refresh-fixtures.mjs'

async function rollbackFailure(source, scenario) {
  const f = await fixture(source)
  const other = await fixture(source, f.identity)
  let raw = f.initial.refreshToken
  const isOldHashCollision = scenario === 'old-hash'
  if (isOldHashCollision) {
    raw = (await f.rotate(raw)).refreshToken
  }
  const before = await stored(source, f.initial.session.id)
  const otherBefore = await stored(source, other.initial.session.id)
  let consumed = false
  let constraint
  let entropyCalls = 0
  let commits = 0
  const restore = instrument(source, {
    query: async ({ sql, parameters, query, run }) => {
      try {
        const isInsertFailure = scenario === 'insert'
        const isRefreshTokenInsert =
          isInsertFailure && sql.startsWith('INSERT INTO "auth_refresh_tokens"')
        const shouldFailInsert = isInsertFailure && isRefreshTokenInsert
        if (shouldFailInsert) {
          // 실제 DB CHECK가 UPDATE 이후 INSERT를 거절하도록 hash parameter만 고장 주입한다.
          assert.equal(consumed, true)
          return await query(sql, [Buffer.alloc(31), ...parameters.slice(1)])
        }
        const result = await run()
        const isRefreshTokenUpdate = sql.startsWith('UPDATE "auth_refresh_tokens"')
        if (isRefreshTokenUpdate) {
          consumed = true
        }
        return result
      } catch (error) {
        constraint = error.constraint ?? error.driverError?.constraint
        throw error
      }
    },
    commit: async (_runner, commit) => {
      commits++
      await commit()
    }
  })
  const signer = f.deps.issueAccessJwt
  const isSigningFailure = scenario === 'signing'
  if (isSigningFailure) {
    f.deps.issueAccessJwt = async () => {
      throw new Error('private detail')
    }
  }
  try {
    const isEntropyFailure = scenario === 'entropy'
    const isHashCollision =
      !isEntropyFailure && ['current-hash', 'old-hash', 'other-device-hash'].includes(scenario)
    if (isEntropyFailure) {
      await rejected(
        () =>
          f.rotateWithBytes(raw, () => {
            entropyCalls++
            throw new Error('private detail')
          }),
        'AUTH_INTERNAL_ERROR'
      )
    } else if (isHashCollision) {
      const isOtherDeviceCollision = scenario === 'other-device-hash'
      const collision = isOtherDeviceCollision ? other.initial.refreshToken : f.initial.refreshToken
      await rejected(
        () =>
          f.rotateWithBytes(raw, () => {
            entropyCalls++
            return Buffer.from(collision, 'base64url')
          }),
        'AUTH_UNAVAILABLE'
      )
      assert.equal(constraint, 'pk_auth_refresh_tokens')
      assert.equal(consumed, true)
    } else {
      await rejected(
        () => f.rotate(raw),
        isSigningFailure ? 'AUTH_INTERNAL_ERROR' : 'AUTH_UNAVAILABLE'
      )
    }
    assert.equal(commits, 0)
    const isInsertFailure = scenario === 'insert'
    if (isInsertFailure) {
      assert.equal(constraint, 'ck_auth_refresh_tokens_hash_length')
    }
    const isHashScenario = !isEntropyFailure && scenario.includes('hash')
    const shouldHaveEntropyCall = isEntropyFailure || isHashScenario
    if (shouldHaveEntropyCall) {
      assert.equal(entropyCalls, 1)
    }
  } finally {
    f.deps.issueAccessJwt = signer
    restore()
  }
  assert.deepEqual(await stored(source, f.initial.session.id), before)
  assert.deepEqual(await stored(source, other.initial.session.id), otherBefore)
  // 실패한 core가 자동 retry한 것이 아니라 test caller가 명시적으로 새 시도를 시작한다.
  await f.rotate(raw)
}

async function uncertainCommit({ source, applied, reuse }) {
  const f = await fixture(source)
  let current = f.initial.refreshToken
  if (reuse) {
    current = (await f.rotate(current)).refreshToken
  }
  const before = await stored(source, f.initial.session.id)
  let attempts = 0
  let commits = 0
  const restore = instrument(source, {
    query: async ({ sql, run }) => {
      const isTransactionStart = sql === 'START TRANSACTION'
      if (isTransactionStart) {
        attempts++
      }
      return run()
    },
    commit: async (runner, commit) => {
      commits++
      // 실제 commit된 DB와 실제 rollback된 DB 모두 같은 불명 응답으로 core에 전달한다.
      if (applied) {
        await commit()
      } else {
        await runner.rollbackTransaction()
      }
      throw new Error('private detail: commit acknowledgement lost')
    }
  })
  try {
    await rejected(() => f.rotate(f.initial.refreshToken), 'AUTH_UNAVAILABLE')
    assert.equal(attempts, 1)
    assert.equal(commits, 1)
  } finally {
    restore()
  }
  const after = await stored(source, f.initial.session.id)
  if (!applied) {
    assert.deepEqual(after, before)
  } else if (reuse) {
    assert.equal(after.session.revoked_reason, 'refresh_reuse')
    assert.deepEqual(after.tokens, before.tokens)
    await rejected(() => f.rotate(current))
  } else {
    assert.equal(after.tokens.length, before.tokens.length + 1)
    assert(
      after.tokens.find((token) => token.token_hash.equals(digest(f.initial.refreshToken)))
        .consumed_at
    )
    assert.equal(after.session.revoked_at, null)
    // 실제 응답 유실과 같은 상태다. 원문을 다시 제출하면 grace 없이 reuse 폐기한다.
    await rejected(() => f.rotate(f.initial.refreshToken))
    assert.equal(
      (await stored(source, f.initial.session.id)).session.revoked_reason,
      'refresh_reuse'
    )
  }
}

export async function assertRefreshFailures(source, mark) {
  const failures = ['signing', 'entropy', 'insert', 'current-hash', 'old-hash', 'other-device-hash']
  for (const scenario of failures) {
    mark(`${scenario} whole-transaction rollback`)
    await rollbackFailure(source, scenario)
  }
  for (const reuse of [false, true]) {
    for (const applied of [false, true]) {
      const operationName = reuse ? 'reuse revocation' : 'rotation'
      const commitOutcome = applied ? 'committed' : 'rolled back'
      const scenarioName = `${operationName} uncertain ${commitOutcome} outcome`
      mark(scenarioName)
      await uncertainCommit({ source, applied, reuse })
    }
  }
  return failures.length + 4
}
