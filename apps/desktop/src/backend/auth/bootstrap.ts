import { createAuthCoordinator } from './coordinator'
import type { AuthRuntimeConfig } from './runtime-config'
import type { AuthRuntimeEffects } from './runtime-effects'
import type { AuthClock, AuthCoordinator } from './types'

export type AuthBootstrapInput = Readonly<{
  config: AuthRuntimeConfig | null
  effects: AuthRuntimeEffects
}>

export type AuthRuntime = Readonly<{
  coordinator: AuthCoordinator
  apiOrigin: string
  clock: AuthClock
}>

export async function bootstrapAuthRuntime(input: AuthBootstrapInput): Promise<AuthRuntime | null> {
  const config = input.config
  if (config == null) {
    return null
  }

  try {
    await input.effects.announceCredentialAccess()
    const dependencies = input.effects.createDependencies()
    const coordinator = createAuthCoordinator(dependencies)
    await coordinator.start()
    return { coordinator, apiOrigin: dependencies.apiOrigin, clock: dependencies.clock }
  } catch {
    return null
  }
}
