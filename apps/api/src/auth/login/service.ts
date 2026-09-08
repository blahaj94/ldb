import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginDependencies, LoginHttpService } from '../../types/login.js'
import { completeLoginCallback } from './callback.js'
import { exchangeLogin } from './exchange.js'
import { authorizeLogin, createLoginRequest } from './start.js'

/** 실제 adapter·등록·key와 초기화된 DB가 준비된 server composition에서만 연결한다. */
export function createLoginService(dependencies: LoginDependencies): LoginHttpService {
  if (
    !dependencies.dataSource?.isInitialized ||
    dependencies.dataSource.options.logging !== false ||
    !dependencies.registry ||
    !dependencies.pkceKeys ||
    typeof dependencies.verifyProvider !== 'function' ||
    typeof dependencies.issueAccessJwt !== 'function'
  ) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }

  // 초기화 뒤 dependency 교체가 진행 중 로그인에 영향을 주지 않도록 참조를 고정한다.
  const deps = Object.freeze({ ...dependencies })
  return Object.freeze({
    create: (input) => createLoginRequest(deps, input),
    authorize: (ticket) => authorizeLogin(deps, ticket),
    callback: (provider, query, cookie) => completeLoginCallback(deps, provider, query, cookie),
    exchange: (input) => exchangeLogin(deps, input)
  } satisfies LoginHttpService)
}
