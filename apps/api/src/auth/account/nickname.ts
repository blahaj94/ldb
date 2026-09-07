import { ACCOUNT_ERRORS, AccountFailure } from './errors.js'

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

export function validateNickname(input: unknown): string {
  const isString = typeof input === 'string'
  if (!isString) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_NICKNAME)

  // Unicode mode는 정상 surrogate pair를 한 code point로 읽으므로 lone surrogate만 검출한다.
  const hasLoneSurrogate = /\p{Surrogate}/u.test(input)
  if (hasLoneSurrogate) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_NICKNAME)

  const hasRawControl = /[\p{Cc}\u2028\u2029]/u.test(input)
  if (hasRawControl) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_NICKNAME)

  const nickname = input.trim()
  const isEmpty = nickname.length === 0
  if (isEmpty) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_NICKNAME)

  const graphemeCount = [...graphemes.segment(nickname)].length
  const isTooLong = graphemeCount > 20
  if (isTooLong) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_NICKNAME)
  return nickname
}
