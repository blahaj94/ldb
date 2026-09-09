import { z } from 'zod'
import { SEARCH_ERRORS, type SearchCommandResult, type SearchSnapshot } from '../types/search'

const uuid = z.string().regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
const revision = z.int().nonnegative()
const nonblank = z.string().refine((value) => {
  const hasText = value.trim().length > 0
  return hasText
})
const row = z.strictObject({
  characterId: nonblank,
  characterName: nonblank,
  serverId: nonblank,
  serverName: z.string().nullable(),
  fame: z.number().nullable()
})
const error = z
  .strictObject({
    code: z.enum(Object.keys(SEARCH_ERRORS) as Array<keyof typeof SEARCH_ERRORS>),
    retryAfterSeconds: revision.nullable()
  })
  .refine((value) => {
    const isRateLimit = value.code === 'SEARCH_RATE_LIMITED'
    const hasNoDelay = value.retryAfterSeconds === null
    const hasValidDelay = isRateLimit || hasNoDelay
    return hasValidDelay
  })
const slot = z
  .strictObject({
    slot: z.int().min(0).max(3),
    observationRevision: revision,
    requestId: uuid.nullable(),
    nickname: z.string().nullable(),
    state: z.enum(['idle', 'pending', 'success', 'empty', 'failure']),
    rows: z.array(row),
    error: error.nullable()
  })
  .refine((value) => {
    const hasRows = value.rows.length > 0
    const hasError = value.error != null
    const hasRequestId = value.requestId != null
    const hasNickname = value.nickname != null
    const hasIdentity = hasRequestId && hasNickname
    const isIdle = value.state === 'idle'
    if (isIdle) {
      const hasNoRequestId = value.requestId === null
      const hasNoNickname = value.nickname === null
      const hasNoIdentity = hasNoRequestId && hasNoNickname
      const isEmpty = hasNoIdentity && !hasRows && !hasError
      return isEmpty
    }
    const hasObservation = value.observationRevision > 0
    const isActive = hasIdentity && hasObservation
    if (!isActive) {
      return false
    }
    const isSuccess = value.state === 'success'
    if (isSuccess) {
      const isComplete = hasRows && !hasError
      return isComplete
    }
    const isFailure = value.state === 'failure'
    if (isFailure) {
      const isFailed = !hasRows && hasError
      return isFailed
    }
    const hasNoResult = !hasRows && !hasError
    return hasNoResult
  })
const snapshotSchema = z
  .strictObject({
    runId: uuid,
    revision,
    captureId: uuid.nullable(),
    slots: z.array(slot).length(4)
  })
  .refine((value) => {
    const hasOrderedSlots = value.slots.every((slot, index) => {
      const isExpectedSlot = slot.slot === index
      return isExpectedSlot
    })
    const hasCapture = value.captureId != null
    const hasOnlyResetSlots = value.slots.every((slot) => {
      const isIdle = slot.state === 'idle'
      const isReset = slot.observationRevision === 0
      const isResetSlot = isIdle && isReset
      return isResetSlot
    })
    const hasValidLifetime = hasCapture || hasOnlyResetSlots
    const isValid = hasOrderedSlots && hasValidLifetime
    return isValid
  })
const resultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), snapshot: snapshotSchema }),
  z.strictObject({
    ok: z.literal(false),
    snapshot: snapshotSchema,
    error: z.strictObject({
      code: z.enum([
        'INVALID_SEARCH_COMMAND',
        'SEARCH_NOT_ALLOWED',
        'STALE_SEARCH',
        'SEARCH_BUSY',
        'SEARCH_RETRY_NOT_READY'
      ])
    })
  })
])

function hasExactOwnShape(input: unknown, parsed: unknown): boolean {
  const isParsedObject = parsed != null && typeof parsed === 'object'
  if (!isParsedObject) {
    return true
  }
  const isInputObject = input != null && typeof input === 'object'
  if (!isInputObject) {
    return false
  }
  const expectedKeys = Reflect.ownKeys(parsed)
  const hasSameKeyCount = Reflect.ownKeys(input).length === expectedKeys.length
  const hasSameFields = expectedKeys.every((key) => {
    const hasOwnField = Object.hasOwn(input, key)
    const hasSameShape =
      hasOwnField && hasExactOwnShape(Reflect.get(input, key), Reflect.get(parsed, key))
    return hasSameShape
  })
  const isExact = hasSameKeyCount && hasSameFields
  return isExact
}

export function parseSearchSnapshot(value: unknown): SearchSnapshot | null {
  const parsed = snapshotSchema.safeParse(value)
  const isValid = parsed.success && hasExactOwnShape(value, parsed.data)
  return isValid ? parsed.data : null
}

export function parseSearchResult(value: unknown): SearchCommandResult | null {
  const parsed = resultSchema.safeParse(value)
  const isValid = parsed.success && hasExactOwnShape(value, parsed.data)
  return isValid ? parsed.data : null
}
