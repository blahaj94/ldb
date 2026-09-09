import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createAccessJwtIssuer, createAccessJwtVerifier } from '../auth/access-jwt/index.js'
import { createGoogleProviderVerifier } from '../auth/google/index.js'
import type { GoogleProviderRegistration } from '../auth/google/types.js'
import { ProviderPkceKeys } from '../auth/login/crypto.js'
import { LoginRegistry } from '../auth/login/registry.js'
import { readDatabaseConfiguration } from '../database/configuration.js'
import { parsePort } from '../port.js'
import { parseAuthenticationInput } from './authentication-input.js'

const invalidConfiguration = 'Invalid API runtime configuration'

function googleProvider(input: ReturnType<typeof parseAuthenticationInput>) {
  const snapshots = new Map(
    input.registry.registrations.map((snapshot) => [snapshot.version, snapshot])
  )
  const registrations: GoogleProviderRegistration[] = []
  const versions = new Set<string>()
  for (const entry of input.google.registrations) {
    const snapshot = snapshots.get(entry.version)
    const hasSnapshot = snapshot !== undefined
    const isDuplicate = versions.has(entry.version)
    const isBindingValid = hasSnapshot && !isDuplicate
    if (!isBindingValid) {
      throw new Error(invalidConfiguration)
    }
    versions.add(entry.version)
    registrations.push({ snapshot, tokenEndpoint: entry.tokenEndpoint, jwksUri: entry.jwksUri })
  }
  const secrets = new Map<string, string>()
  for (const entry of input.google.secrets) {
    const snapshot = snapshots.get(entry.version)
    const hasSnapshot = snapshot !== undefined
    const hasMatchingReference = hasSnapshot && snapshot.providerSecretRef === entry.reference
    // 구분자나 object property로 합치지 않아 version/reference tuple의 의미를 보존한다.
    const binding = JSON.stringify([entry.version, entry.reference])
    const isDuplicate = secrets.has(binding)
    const isBindingValid = hasMatchingReference && !isDuplicate
    if (!isBindingValid) {
      throw new Error(invalidConfiguration)
    }
    secrets.set(binding, entry.value)
  }
  const hasAllEndpoints = versions.size === snapshots.size
  const hasAllSecrets = secrets.size === snapshots.size
  const isComplete = hasAllEndpoints && hasAllSecrets
  if (!isComplete) {
    throw new Error(invalidConfiguration)
  }
  return createGoogleProviderVerifier({
    registrations,
    resolveSecret: ({ version, reference, signal }) => {
      const secret = secrets.get(JSON.stringify([version, reference]))
      const hasSecret = secret !== undefined
      const isCancelled = signal.aborted
      const canResolve = hasSecret && !isCancelled
      if (!canResolve) {
        throw new Error(invalidConfiguration)
      }
      return secret
    }
  })
}

/** 기본 entry가 전달한 환경과 파일을 한 번 읽고 DB 연결 전에 검증을 끝낸다. */
export async function readRuntimeConfiguration(environment: NodeJS.ProcessEnv) {
  try {
    const port = parsePort(environment.PORT)
    const database = readDatabaseConfiguration(environment)
    const apiKey = environment.NEOPLE_API_KEY
    const isApiKeyDefined = apiKey !== undefined
    const hasApiKeyContent = isApiKeyDefined && apiKey.length > 0
    const hasApiKey = isApiKeyDefined && hasApiKeyContent
    if (!hasApiKey) {
      throw new Error(invalidConfiguration)
    }
    const path = environment.AUTH_CONFIG_FILE
    const isPathDefined = path !== undefined
    const hasPathContent = isPathDefined && path.length > 0
    const hasPath = isPathDefined && hasPathContent
    const hasAbsolutePath = hasPath && isAbsolute(path)
    if (!hasAbsolutePath) {
      throw new Error(invalidConfiguration)
    }
    const bytes = await readFile(path)
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const input = parseAuthenticationInput(JSON.parse(json) as unknown)
    const registry = new LoginRegistry(input.registry)
    const pkceKeys = new ProviderPkceKeys(input.providerPkce)
    const issueAccessJwt = await createAccessJwtIssuer(input.accessJwt)
    const verifyAccessJwt = await createAccessJwtVerifier(input.accessJwt)
    const verifyProvider = googleProvider(input)
    return {
      port,
      database,
      apiKey,
      registry,
      pkceKeys,
      issueAccessJwt,
      verifyAccessJwt,
      verifyProvider
    }
  } catch {
    // FS/JSON/crypto의 error와 cause는 파일 경로나 값을 포함할 수 있다.
    throw new Error(invalidConfiguration)
  }
}
