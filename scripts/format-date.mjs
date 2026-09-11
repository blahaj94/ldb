import { pathToFileURL } from 'node:url'

const koreanDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

export function formatDate(timestamp) {
  const isString = typeof timestamp === 'string'
  const hasUtcIsoShape =
    isString && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
  if (!hasUtcIsoShape) {
    throw new Error('Expected a valid UTC ISO timestamp ending in Z')
  }

  const date = new Date(timestamp)
  const isValidInstant = Number.isFinite(date.getTime())
  const hasOriginalCalendarFields =
    isValidInstant && date.toISOString().slice(0, 19) === timestamp.slice(0, 19)
  if (!hasOriginalCalendarFields) {
    throw new Error('Expected a valid UTC ISO timestamp ending in Z')
  }

  const parts = koreanDate.formatToParts(date)
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${fields.year}년 ${fields.month}월 ${fields.day}일 ${fields.hour}시 ${fields.minute}분`
}

const entryPath = process.argv[1]
const hasEntryPath = entryPath != null
if (hasEntryPath) {
  const isDirectRun = import.meta.url === pathToFileURL(entryPath).href
  if (isDirectRun) {
    try {
      const hasExtraArguments = process.argv.length > 3
      if (hasExtraArguments) {
        throw new Error('Expected at most one UTC ISO timestamp')
      }

      const timestamp = process.argv[2] ?? new Date().toISOString()
      console.log(formatDate(timestamp))
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
