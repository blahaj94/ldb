import { z } from 'zod'
import type { SearchControl, SearchObservation } from '../../preload/common/types/search'

const text = z.string()
const uuid = text.regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
const safeInteger = z.int()
const revision = safeInteger.nonnegative()
const observationRevision = safeInteger.positive()
const slot = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
const controlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({ action: z.literal('begin'), authRunId: uuid, authRevision: revision }),
  z.strictObject({ action: z.literal('end'), captureId: uuid }),
  z.strictObject({ action: z.literal('clear'), captureId: uuid, slot, observationRevision }),
  z.strictObject({ action: z.literal('retry'), captureId: uuid, slot, requestId: uuid })
])
const observationSchema = z.strictObject({
  captureId: uuid,
  slot,
  observationRevision,
  nickname: text
})

function parseCommand<T extends object>({
  args,
  schema
}: {
  args: unknown[]
  schema: z.ZodType<T>
}): T | null {
  const hasOneArgument = args.length === 1
  const value = args[0]
  const isObject = value != null && typeof value === 'object' && !Array.isArray(value)
  const canParse = hasOneArgument && isObject
  if (!canParse) {
    return null
  }

  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const keys = Reflect.ownKeys(value)
  const hasExactKeyCount = keys.length === Object.keys(parsed.data).length
  const hasOnlyExpectedKeys = keys.every((key) => {
    const isStringKey = typeof key === 'string'
    const isExpectedKey = isStringKey && Object.hasOwn(parsed.data, key)
    return isExpectedKey
  })
  const hasExactKeys = hasExactKeyCount && hasOnlyExpectedKeys
  return hasExactKeys ? parsed.data : null
}

export function parseSearchControl(args: unknown[]): SearchControl | null {
  return parseCommand({ args, schema: controlSchema })
}

export function parseSearchObservation(args: unknown[]): SearchObservation | null {
  return parseCommand({ args, schema: observationSchema })
}
