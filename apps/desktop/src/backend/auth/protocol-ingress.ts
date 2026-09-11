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

export type ProtocolIngressInput = Readonly<{
  app: ProtocolIngressApp
  argv: readonly unknown[]
  returnTarget: string
}>

export type ProtocolIngress = Readonly<{
  ownsInstance: boolean
  attach(dispatch: ProtocolIngressDispatch): () => void
  dispose(): void
}>

export function attachProtocolIngressAfterStart(
  ingress: ProtocolIngress,
  start: Promise<unknown>,
  dispatch: ProtocolIngressDispatch,
  isActive: () => boolean = () => true
): () => void {
  let active = true
  let detach: (() => void) | undefined
  void start.then(
    () => {
      if (!active || !isActive()) {
        return
      }
      detach = ingress.attach(dispatch)
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

function findReturnCandidate(
  values: readonly unknown[],
  returnProtocol: string,
  returnTarget: string
): string | null {
  let candidate: string | null = null
  let candidateCount = 0
  for (const value of values) {
    const isString = typeof value === 'string'
    if (!isString) {
      continue
    }

    const protocolPrefix = value.slice(0, returnProtocol.length).toLowerCase()
    const hasReturnProtocol = protocolPrefix === returnProtocol
    if (!hasReturnProtocol) {
      continue
    }

    candidateCount += 1
    candidate = value
  }

  const hasSingleCandidate = candidateCount === 1
  if (!hasSingleCandidate) {
    return null
  }

  const hasCandidate = candidate != null
  if (!hasCandidate) {
    return null
  }

  try {
    parseReturnUrl(candidate, returnTarget)
  } catch {
    return null
  }

  return candidate
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
  let bufferedReturnUrl = findReturnCandidate(input.argv, returnProtocol, returnTarget)
  let dispatch: ProtocolIngressDispatch | null = null
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

  function receive(values: readonly unknown[]): void {
    if (disposed) {
      return
    }

    const candidate = findReturnCandidate(values, returnProtocol, returnTarget)
    const hasCandidate = candidate != null
    if (!hasCandidate) {
      return
    }

    deliver(candidate)
  }

  const handleOpenUrl: ProtocolOpenUrlListener = (event, url) => {
    event.preventDefault()
    receive([url])
  }
  const handleSecondInstance: ProtocolSecondInstanceListener = (_event, commandLine) => {
    receive(commandLine)
  }

  input.app.on('open-url', handleOpenUrl)
  input.app.on('second-instance', handleSecondInstance)

  function attach(nextDispatch: ProtocolIngressDispatch): () => void {
    if (disposed) {
      return () => undefined
    }

    const hasDispatch = dispatch != null
    if (hasDispatch) {
      throw new Error('Protocol ingress is already attached.')
    }

    dispatch = nextDispatch
    const pendingReturnUrl = bufferedReturnUrl
    const hasPendingReturnUrl = pendingReturnUrl != null
    bufferedReturnUrl = null
    let isAttached = true
    const detach = (): void => {
      if (!isAttached) {
        return
      }

      isAttached = false
      const ownsDispatch = dispatch === nextDispatch
      if (ownsDispatch) {
        dispatch = null
      }
    }

    if (hasPendingReturnUrl) {
      deliver(pendingReturnUrl)
    }

    return detach
  }

  function dispose(): void {
    if (disposed) {
      return
    }

    disposed = true
    dispatch = null
    bufferedReturnUrl = null
    input.app.removeListener('open-url', handleOpenUrl)
    input.app.removeListener('second-instance', handleSecondInstance)
  }

  return { ownsInstance: true, attach, dispose }
}
