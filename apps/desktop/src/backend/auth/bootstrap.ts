import { createAuthCoordinator } from './coordinator'
import type { AuthRuntimeConfig } from './runtime-config'
import type { AuthRuntimeEffects } from './runtime-effects'
import type { AuthClock, AuthCoordinator, AuthSnapshot } from './types'

export type AuthBootstrapInput = Readonly<{
  config: AuthRuntimeConfig | null
  effects: AuthRuntimeEffects
  isActive?(): boolean
}>

export type AuthRuntime = Readonly<{
  coordinator: AuthCoordinator
  apiOrigin: string
  searchClock: AuthClock
  start(): Promise<AuthSnapshot>
}>

export async function bootstrapAuthRuntime(input: AuthBootstrapInput): Promise<AuthRuntime | null> {
  const config = input.config
  if (config == null) {
    return null
  }
  if (input.isActive?.() === false) {
    return null
  }

  try {
    await input.effects.announceCredentialAccess()
  } catch {
    return null
  }
  if (input.isActive?.() === false) {
    return null
  }

  const dependencies = input.effects.createDependencies(config)
  const searchClock = input.effects.createSearchClock()
  const coordinator = createAuthCoordinator(dependencies)
  let startPromise: Promise<AuthSnapshot> | null = null
  const start = (): Promise<AuthSnapshot> => {
    const existingStart = startPromise
    if (existingStart != null) {
      return existingStart
    }
    const started = coordinator.start()
    startPromise = started
    return started
  }
  return { coordinator, apiOrigin: dependencies.apiOrigin, searchClock, start }
}
