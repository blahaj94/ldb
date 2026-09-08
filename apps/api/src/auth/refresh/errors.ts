import { AUTH_ERRORS } from '../../constants/auth.js'
import { LOGIN_ERRORS } from '../../constants/login.js'

type RefreshErrorDefinitionShape = Readonly<{
  code: string
  status: number
  message: string
}>

export const REFRESH_ERRORS = {
  ...AUTH_ERRORS,
  INVALID_REQUEST: LOGIN_ERRORS.INVALID_REQUEST,
  AUTHENTICATION_REQUIRED: {
    code: 'AUTHENTICATION_REQUIRED',
    status: 401,
    message: '로그인이 필요합니다.'
  }
} as const satisfies Record<string, RefreshErrorDefinitionShape>

export type RefreshErrorDefinition = (typeof REFRESH_ERRORS)[keyof typeof REFRESH_ERRORS]

export class RefreshFailure extends Error {
  readonly code: RefreshErrorDefinition['code']
  readonly status: RefreshErrorDefinition['status']

  constructor(definition: RefreshErrorDefinition) {
    super(definition.message)
    this.name = 'RefreshFailure'
    this.code = definition.code
    this.status = definition.status
    this.stack = `${this.name}: ${this.message}`
  }
}
