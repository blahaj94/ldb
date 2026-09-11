import { parseReturnUrl, validateReturnTarget } from './protocol'

export type ProtocolOpenUrlEvent = Readonly<{
  preventDefault(): void
}>

type ProtocolOpenUrlListener = (event: ProtocolOpenUrlEvent, url: unknown) => void
type ProtocolSecondInstanceListener = (
  event: unknown,
  commandLine: readonly unknown[],
  workingDirectory: unknown,
  additionalData: unknown
) => void

export interface ProtocolIngressApp {
  requestSingleInstanceLock(additionalData: Record<string, unknown>): boolean
  quit(): void
  on(event: 'open-url', listener: ProtocolOpenUrlListener): void
  on(event: 'second-instance', listener: ProtocolSecondInstanceListener): void
  removeListener(event: 'open-url', listener: ProtocolOpenUrlListener): void
  removeListener(event: 'second-instance', listener: ProtocolSecondInstanceListener): void
}

export type ProtocolIngressDispatch = (rawReturnUrl: string) => Promise<void> | void
export type ProtocolIngressActivation = () => Promise<void> | void

export type ProtocolIngressInput = Readonly<{
  app: ProtocolIngressApp
  argv: readonly unknown[]
  returnTarget: string
}>

export type ProtocolIngress = Readonly<{
  ownsInstance: boolean
  attach(dispatch: ProtocolIngressDispatch, activate?: ProtocolIngressActivation): () => void
  dispose(): void
}>

export function attachProtocolIngressAfterStart(
  ingress: ProtocolIngress,
  start: Promise<unknown>,
  dispatch: ProtocolIngressDispatch,
  isActive: () => boolean = () => true,
  activate?: ProtocolIngressActivation
): () => void {
  let active = true
  let detach: (() => void) | undefined
  void start.then(
    () => {
      if (!active || !isActive()) {
        return
      }
      const activation = activate
      const hasActivation = activation != null
      const guardedActivation = hasActivation
        ? () => {
            if (!active) {
              return
            }

            const ownerIsActive = isActive()
            if (!ownerIsActive) {
              return
            }

            return activation()
          }
        : undefined
      const guardedDispatch = async (rawReturnUrl: string): Promise<void> => {
        if (!active || !isActive()) {
          return
        }
        await dispatch(rawReturnUrl)
      }
      const hasGuardedActivation = guardedActivation != null
      const attachedDetach = hasGuardedActivation
        ? ingress.attach(guardedDispatch, guardedActivation)
        : ingress.attach(guardedDispatch)
      const shouldDetachImmediately = !active || !isActive()
      if (shouldDetachImmediately) {
        attachedDetach()
        return
      }
      detach = attachedDetach
    },
    () => {
      ingress.dispose()
    }
  )

  return () => {
    active = false
    detach?.()
  }
}

type ReturnCandidateClassification =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'valid'; rawReturnUrl: string }>

type BoundedArguments =
  Readonly<{ status: 'invalid' }> | Readonly<{ status: 'valid'; values: readonly string[] }>

const SECOND_INSTANCE_HANDOFF_VERSION = 1
const MAX_HANDOFF_ARGUMENTS = 64
const MAX_HANDOFF_ARGUMENT_BYTES = 4_096
const MAX_HANDOFF_TOTAL_BYTES = 16_384

function readBoundedArguments(value: unknown): BoundedArguments {
  if (!Array.isArray(value) || value.length > MAX_HANDOFF_ARGUMENTS) {
    return { status: 'invalid' }
  }

  const values: string[] = []
  let totalBytes = 0
  for (const argument of value) {
    if (typeof argument !== 'string') {
      return { status: 'invalid' }
    }
    const bytes = Buffer.byteLength(argument, 'utf8')
    totalBytes += bytes
    const isWithinBounds =
      bytes <= MAX_HANDOFF_ARGUMENT_BYTES && totalBytes <= MAX_HANDOFF_TOTAL_BYTES
    if (!isWithinBounds) {
      return { status: 'invalid' }
    }
    values.push(argument)
  }

  return { status: 'valid', values }
}

function createSecondInstanceHandoff(argv: readonly unknown[]): Record<string, unknown> {
  const bounded = readBoundedArguments(argv)
  return {
    version: SECOND_INSTANCE_HANDOFF_VERSION,
    argv: bounded.status === 'valid' ? [...bounded.values] : null
  }
}

function readSecondInstanceHandoff(value: unknown): BoundedArguments {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid' }
  }
  const keys = Reflect.ownKeys(value)
  const hasExactKeys = keys.length === 2 && keys.includes('version') && keys.includes('argv')
  if (!hasExactKeys) {
    return { status: 'invalid' }
  }
  const version = Object.getOwnPropertyDescriptor(value, 'version')?.value
  const argv = Object.getOwnPropertyDescriptor(value, 'argv')?.value
  if (version !== SECOND_INSTANCE_HANDOFF_VERSION) {
    return { status: 'invalid' }
  }
  return readBoundedArguments(argv)
}

export function selectProtocolIngressArguments(
  argv: readonly unknown[],
  isDefaultApp: boolean
): readonly unknown[] {
  const bootstrapArgumentCount = isDefaultApp ? 2 : 1
  return argv.slice(bootstrapArgumentCount)
}

type ProjectedUrlInput = Readonly<{
  value: string
  hasInternalControl: boolean
  matchesRaw: boolean
}>

function projectUrlDetectionInput(value: string): ProjectedUrlInput {
  const characters = Array.from(value)
  let first = 0
  let last = characters.length
  const isEdgeIgnored = (character: string): boolean => {
    const codePoint = character.codePointAt(0)!
    const isWhitespace = character.trim().length === 0
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    return isWhitespace || isControl
  }
  while (first < last && isEdgeIgnored(characters[first]!)) {
    first += 1
  }
  while (last > first && isEdgeIgnored(characters[last - 1]!)) {
    last -= 1
  }

  let projected = ''
  let hasInternalControl = false
  for (const character of characters.slice(first, last)) {
    const codePoint = character.codePointAt(0)!
    const isParserIgnoredInternal = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
    const isOtherControl =
      (codePoint <= 0x1f && !isParserIgnoredInternal) || (codePoint >= 0x7f && codePoint <= 0x9f)
    hasInternalControl ||= isOtherControl
    if (!isParserIgnoredInternal) {
      projected += character
    }
  }

  return { value: projected, hasInternalControl, matchesRaw: projected === value }
}

type StructuredOptionPayload = Readonly<{
  name: string
  value: string
}>

function readStructuredOptionPayload(value: string): StructuredOptionPayload | undefined {
  const prefixLength = value.startsWith('--') ? 2 : value.startsWith('/') ? 1 : 0
  if (prefixLength === 0) {
    return undefined
  }

  const option = value.slice(prefixLength)
  const separatorIndexes = [option.indexOf('='), option.indexOf(':')].filter((index) => index >= 0)
  const separatorIndex = Math.min(...separatorIndexes)
  if (!Number.isFinite(separatorIndex) || separatorIndex < 0) {
    return undefined
  }

  const name = option.slice(0, separatorIndex)
  const isSlashOptionWithPathName = prefixLength === 1 && /[\\/]/.test(name)
  if (isSlashOptionWithPathName) {
    return undefined
  }

  return {
    name: name.toLowerCase(),
    value: option.slice(separatorIndex + 1)
  }
}

function looksLikeUrlInput(value: string): boolean {
  const projectedArgument = projectUrlDetectionInput(value)
  const structuredOption = readStructuredOptionPayload(projectedArgument.value)
  const projectedPayload =
    structuredOption == null ? projectedArgument : projectUrlDetectionInput(structuredOption.value)
  const projected = projectedPayload.value
  const hasInternalControl =
    projectedArgument.hasInternalControl || projectedPayload.hasInternalControl
  const isKnownAbsoluteWindowsPathOption =
    structuredOption?.name === 'user-data-dir' &&
    projectedArgument.matchesRaw &&
    projectedPayload.matchesRaw &&
    /^[A-Za-z]:[\\/](?![\\/])/.test(projected)

  if (isKnownAbsoluteWindowsPathOption) {
    return hasInternalControl && projected.includes(':')
  }

  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(projected)
  const hasMalformedHierarchicalScheme = /^[^/?#]*:[\\/]+/.test(projected)
  const hasControlBeforeDelimiter = hasInternalControl && projected.includes(':')
  return hasScheme || hasMalformedHierarchicalScheme || hasControlBeforeDelimiter
}

function classifyReturnCandidate(
  values: readonly unknown[],
  returnProtocol: string,
  returnTarget: string
): ReturnCandidateClassification {
  let candidate = ''
  let candidateCount = 0
  let hasUnexpectedUrl = false
  for (const value of values) {
    const isString = typeof value === 'string'
    if (!isString) {
      continue
    }

    const protocolPrefix = value.slice(0, returnProtocol.length).toLowerCase()
    const hasReturnProtocol = protocolPrefix === returnProtocol
    if (!hasReturnProtocol) {
      if (looksLikeUrlInput(value)) {
        hasUnexpectedUrl = true
      }
      continue
    }

    candidateCount += 1
    candidate = value
  }

  if (hasUnexpectedUrl) {
    return { status: 'invalid' }
  }

  const hasNoCandidate = candidateCount === 0
  if (hasNoCandidate) {
    return { status: 'none' }
  }

  const hasSingleCandidate = candidateCount === 1
  if (!hasSingleCandidate) {
    return { status: 'invalid' }
  }

  const rawReturnUrl = candidate
  try {
    parseReturnUrl(rawReturnUrl, returnTarget)
  } catch {
    return { status: 'invalid' }
  }

  return { status: 'valid', rawReturnUrl }
}

export function isOrdinarySecondInstanceInvocation(
  additionalData: unknown,
  returnTarget: string
): boolean {
  const validatedReturnTarget = validateReturnTarget(returnTarget)
  const returnProtocol = new URL(validatedReturnTarget).protocol
  const handoff = readSecondInstanceHandoff(additionalData)
  if (handoff.status === 'invalid') {
    return false
  }
  const candidate = classifyReturnCandidate(handoff.values, returnProtocol, validatedReturnTarget)
  const hasNoReturnCandidate = candidate.status === 'none'

  return hasNoReturnCandidate
}

function createInactiveIngress(): ProtocolIngress {
  return {
    ownsInstance: false,
    attach: () => () => undefined,
    dispose: () => undefined
  }
}

export function createProtocolIngress(input: ProtocolIngressInput): ProtocolIngress {
  const returnTarget = validateReturnTarget(input.returnTarget)
  const initialArguments = readBoundedArguments(input.argv)
  const ownsInstance = input.app.requestSingleInstanceLock(createSecondInstanceHandoff(input.argv))
  if (!ownsInstance) {
    input.app.quit()
    return createInactiveIngress()
  }

  const returnProtocol = new URL(returnTarget).protocol
  const initialCandidate =
    initialArguments.status === 'valid'
      ? classifyReturnCandidate(initialArguments.values, returnProtocol, returnTarget)
      : { status: 'invalid' as const }
  const hasValidInitialCandidate = initialCandidate.status === 'valid'
  let bufferedReturnUrl = hasValidInitialCandidate ? initialCandidate.rawReturnUrl : null
  let bufferedActivation = false
  let dispatch: ProtocolIngressDispatch | null = null
  let activate: ProtocolIngressActivation | null = null
  let disposed = false

  function deliver(rawReturnUrl: string): void {
    const currentDispatch = dispatch
    const hasCurrentDispatch = currentDispatch != null
    if (!hasCurrentDispatch) {
      const hasBufferedReturnUrl = bufferedReturnUrl != null
      if (!hasBufferedReturnUrl) {
        bufferedReturnUrl = rawReturnUrl
      }
      return
    }

    try {
      void Promise.resolve(currentDispatch(rawReturnUrl)).catch(() => undefined)
    } catch {
      return
    }
  }

  function deliverActivation(): void {
    const currentActivation = activate
    const hasCurrentActivation = currentActivation != null
    if (!hasCurrentActivation) {
      bufferedActivation = true
      return
    }

    try {
      void Promise.resolve(currentActivation()).catch(() => undefined)
    } catch {
      return
    }
  }

  function receiveReturn(values: readonly unknown[]): void {
    if (disposed) {
      return
    }

    const candidate = classifyReturnCandidate(values, returnProtocol, returnTarget)
    const hasValidCandidate = candidate.status === 'valid'
    if (!hasValidCandidate) {
      return
    }

    deliver(candidate.rawReturnUrl)
  }

  function receiveSecondInstance(values: readonly unknown[]): void {
    if (disposed) {
      return
    }

    const candidate = classifyReturnCandidate(values, returnProtocol, returnTarget)
    const hasValidCandidate = candidate.status === 'valid'
    if (hasValidCandidate) {
      deliver(candidate.rawReturnUrl)
      return
    }

    const hasNoCandidate = candidate.status === 'none'
    if (hasNoCandidate) {
      deliverActivation()
    }
  }

  const handleOpenUrl: ProtocolOpenUrlListener = (event, url) => {
    event.preventDefault()
    receiveReturn([url])
  }
  const handleSecondInstance: ProtocolSecondInstanceListener = (
    _event,
    _commandLine,
    _workingDirectory,
    additionalData
  ) => {
    const handoff = readSecondInstanceHandoff(additionalData)
    if (handoff.status === 'invalid') {
      return
    }
    receiveSecondInstance(handoff.values)
  }

  input.app.on('open-url', handleOpenUrl)
  input.app.on('second-instance', handleSecondInstance)

  function attach(
    nextDispatch: ProtocolIngressDispatch,
    nextActivation?: ProtocolIngressActivation
  ): () => void {
    if (disposed) {
      return () => undefined
    }

    const hasDispatch = dispatch != null
    if (hasDispatch) {
      throw new Error('Protocol ingress is already attached.')
    }

    dispatch = nextDispatch
    activate = nextActivation ?? null
    const pendingReturnUrl = bufferedReturnUrl
    const hasPendingReturnUrl = pendingReturnUrl != null
    bufferedReturnUrl = null
    const hasPendingActivation = bufferedActivation && activate != null
    if (hasPendingActivation) {
      bufferedActivation = false
    }
    let isAttached = true
    const detach = (): void => {
      if (!isAttached) {
        return
      }

      isAttached = false
      const ownsDispatch = dispatch === nextDispatch
      if (ownsDispatch) {
        dispatch = null
        activate = null
      }
    }

    if (hasPendingReturnUrl) {
      deliver(pendingReturnUrl)
    }
    if (hasPendingActivation) {
      deliverActivation()
    }

    return detach
  }

  function dispose(): void {
    if (disposed) {
      return
    }

    disposed = true
    dispatch = null
    activate = null
    bufferedReturnUrl = null
    bufferedActivation = false
    input.app.removeListener('open-url', handleOpenUrl)
    input.app.removeListener('second-instance', handleSecondInstance)
  }

  return { ownsInstance: true, attach, dispose }
}
