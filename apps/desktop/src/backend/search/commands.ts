import { z } from 'zod'
import type { SearchControl } from '../../preload/common/types/search'

const uuid = z.string().regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
const controlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({
    action: z.literal('begin'),
    authRunId: uuid,
    authRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  }),
  z.strictObject({ action: z.literal('end'), captureId: uuid })
])

export function parseSearchControl(args: unknown[]): SearchControl | null {
  const hasOneArgument = args.length === 1
  const value = args[0]
  const isObject = value != null && typeof value === 'object' && !Array.isArray(value)
  const canParse = hasOneArgument && isObject
  if (!canParse) return null
  const parsed = controlSchema.safeParse(value)
  if (!parsed.success) return null
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
