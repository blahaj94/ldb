import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginDependencies, LoginHttpService } from '../../types/login.js'
import { completeLoginCallback } from './callback.js'
import { exchangeLogin } from './exchange.js'
import { authorizeLogin, createLoginRequest } from './start.js'

/** 실제 adapter·등록·key와 초기화된 DB가 준비된 server composition에서만 연결한다. */
export function createLoginService(dependencies: LoginDependencies): LoginHttpService {
  const isDataSourceInitialized = Boolean(dependencies.dataSource?.isInitialized)
  const isLoggingDisabled =
    isDataSourceInitialized && dependencies.dataSource.options.logging === false
  const hasRegistry = isLoggingDisabled && Boolean(dependencies.registry)
  const hasPkceKeys = hasRegistry && Boolean(dependencies.pkceKeys)
  const isProviderVerifierFunction =
    hasPkceKeys && typeof dependencies.verifyProvider === 'function'
  const isAccessJwtIssuerFunction =
    isProviderVerifierFunction && typeof dependencies.issueAccessJwt === 'function'
  const areDependenciesInvalid =
    !isDataSourceInitialized ||
    !isLoggingDisabled ||
    !hasRegistry ||
    !hasPkceKeys ||
    !isProviderVerifierFunction ||
    !isAccessJwtIssuerFunction
  if (areDependenciesInvalid) {
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
