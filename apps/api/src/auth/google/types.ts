import type { ProviderRegistration } from '../../types/login.js'

export interface GoogleProviderRegistration {
  readonly snapshot: ProviderRegistration
  readonly tokenEndpoint: string
  readonly jwksUri: string
}

/** Server composition이 승인된 trusted endpoint와 historical secret 해석을 제공한다. */
export interface GoogleProviderConfiguration {
  readonly registrations: readonly GoogleProviderRegistration[]
  readonly resolveSecret: (binding: {
    readonly version: string
    readonly reference: string
    readonly signal: AbortSignal
  }) => string | Promise<string>
  readonly fetch?: typeof globalThis.fetch
}
