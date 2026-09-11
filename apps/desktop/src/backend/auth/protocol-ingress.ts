import { parseReturnUrl, validateReturnTarget } from './protocol'

export type ProtocolOpenUrlEvent = Readonly<{
  preventDefault(): void
}>

type ProtocolOpenUrlListener = (event: ProtocolOpenUrlEvent, url: unknown) => void
type ProtocolSecondInstanceListener = (
  event: unknown,
  commandLine: readonly unknown[],
  workingDirectory: unknown
) => void

export interface ProtocolIngressApp {
  requestSingleInstanceLock(): boolean
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
      const classificationValue = value.trimStart()
      const hasUriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(classificationValue)
      const hasUrlDelimiter = classificationValue.includes('://')
      const isWindowsDrivePath = /^[A-Za-z]:/.test(classificationValue)
      if ((hasUriScheme || hasUrlDelimiter) && !isWindowsDrivePath) {
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
  values: readonly unknown[],
  returnTarget: string
): boolean {
  const validatedReturnTarget = validateReturnTarget(returnTarget)
  const returnProtocol = new URL(validatedReturnTarget).protocol
  const candidate = classifyReturnCandidate(values, returnProtocol, validatedReturnTarget)
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
  const ownsInstance = input.app.requestSingleInstanceLock()
  if (!ownsInstance) {
    input.app.quit()
    return createInactiveIngress()
  }

  const returnProtocol = new URL(returnTarget).protocol
  const initialCandidate = classifyReturnCandidate(input.argv, returnProtocol, returnTarget)
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
  const handleSecondInstance: ProtocolSecondInstanceListener = (_event, commandLine) => {
    receiveSecondInstance(commandLine)
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
