import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthApi, AuthSnapshot } from '../../../preload/common/types/auth'
import type { AuthIntent } from './presentation'

type BridgeState = {
  presentationEpoch: number
  snapshot: AuthSnapshot | null
  commandPending: boolean
  connectionFailed: boolean
}
type AuthBridge = BridgeState & {
  onIntent: (intent: AuthIntent) => void
  resynchronize: () => void
}

export function useAuthBridge(api: AuthApi): AuthBridge {
  const presentationEpochRef = useRef(0)
  const [state, setState] = useState<BridgeState & { source: AuthApi }>({
    source: api,
    presentationEpoch: 0,
    snapshot: null,
    commandPending: false,
    connectionFailed: false
  })
  const reconnect = useRef<() => void>(() => {})
  const dispatch = useRef<(intent: AuthIntent) => void>(() => {})

  useEffect(() => {
    let active = true
    let epoch = 0
    let current: AuthSnapshot | null = null
    let pending = false
    let baselineReady = false
    let queued: AuthSnapshot | null = null
    let unsubscribe = (): void => {}

    function isCurrent(expected: number): boolean {
      const hasSameEpoch = expected === epoch
      const isActiveEpoch = active && hasSameEpoch
      return isActiveEpoch
    }

    function accept(snapshot: AuthSnapshot, expected: number): void {
      const isActiveEpoch = isCurrent(expected)
      if (!isActiveEpoch) return
      const previous = current
      const hasCurrent = previous != null
      const hasChangedRun = hasCurrent && previous.runId !== snapshot.runId
      if (hasChangedRun) {
        connect()
        return
      }
      const isNewer = !hasCurrent || snapshot.revision > previous.revision
      if (!isNewer) return
      const wasSignedIn = hasCurrent && previous.phase === 'signedIn'
      const isSignedIn = snapshot.phase === 'signedIn'
      const hasLeftSignedIn = wasSignedIn && !isSignedIn
      // React가 여러 auth event를 한 render로 합쳐도 이전 home을 재사용하지 않는다.
      if (hasLeftSignedIn) presentationEpochRef.current += 1
      current = snapshot
      setState({
        source: api,
        presentationEpoch: presentationEpochRef.current,
        snapshot,
        commandPending: pending,
        connectionFailed: false
      })
    }

    async function query(expected: number, establish = false): Promise<void> {
      try {
        const snapshot = await api.getAuthState()
        const isActiveEpoch = isCurrent(expected)
        if (!isActiveEpoch) return
        if (establish) baselineReady = true
        accept(snapshot, expected)
        const buffered = queued
        queued = null
        const hasBuffered = buffered != null
        if (hasBuffered) accept(buffered, expected)
      } catch {
        const isActiveEpoch = isCurrent(expected)
        if (!isActiveEpoch) return
        current = null
        setState({
          source: api,
          presentationEpoch: presentationEpochRef.current,
          snapshot: null,
          commandPending: pending,
          connectionFailed: true
        })
      }
    }

    function connect(): void {
      unsubscribe()
      const isReconnect = epoch > 0
      epoch += 1
      const expected = epoch
      current = null
      pending = false
      baselineReady = false
      queued = null
      if (isReconnect)
        setState({
          source: api,
          presentationEpoch: presentationEpochRef.current,
          snapshot: null,
          commandPending: false,
          connectionFailed: false
        })
      try {
        unsubscribe = api.onAuthStateChanged((snapshot) => {
          const isActiveEpoch = isCurrent(expected)
          if (!isActiveEpoch) return
          if (baselineReady) {
            accept(snapshot, expected)
            return
          }
          const buffered = queued
          const hasQueued = buffered != null
          const hasSameRun = hasQueued && buffered.runId === snapshot.runId
          const isOlder = hasSameRun && snapshot.revision <= buffered.revision
          if (!isOlder) queued = snapshot
        })
        void query(expected, true)
      } catch {
        setState({
          source: api,
          presentationEpoch: presentationEpochRef.current,
          snapshot: null,
          commandPending: false,
          connectionFailed: true
        })
      }
    }

    async function command(intent: AuthIntent): Promise<void> {
      const cannotDispatch = !active || pending || current == null
      if (cannotDispatch) return
      const expected = epoch
      pending = true
      setState((previous) => ({ ...previous, commandPending: true }))
      try {
        const result = await (() => {
          switch (intent.type) {
            case 'beginLogin':
              return api.beginLogin({ provider: intent.provider })
            case 'cancelLogin':
              return api.cancelLogin({ attemptId: intent.attemptId })
            case 'retryAuth':
              return api.retryAuth()
            case 'logout':
              return api.logout()
          }
        })()
        accept(result.snapshot, expected)
      } catch {
        // Mutation은 다시 보내지 않는다. 현재 main snapshot만 조회한다.
        const isActiveEpoch = isCurrent(expected)
        if (isActiveEpoch) await query(expected)
      } finally {
        const isActiveEpoch = isCurrent(expected)
        if (isActiveEpoch) {
          pending = false
          setState((previous) => ({ ...previous, commandPending: false }))
        }
      }
    }

    dispatch.current = (intent) => {
      void command(intent)
    }
    reconnect.current = connect
    connect()
    return () => {
      reconnect.current = () => {}
      active = false
      epoch += 1
      unsubscribe()
    }
  }, [api])

  const resynchronize = useCallback((): void => reconnect.current(), [])
  const onIntent = useCallback((intent: AuthIntent): void => dispatch.current(intent), [])
  const hasSameSource = state.source === api
  if (!hasSameSource) {
    // API 객체가 다시 사용되어도 이전 연결의 계정 state를 복구하지 않는다.
    setState({
      source: api,
      presentationEpoch: state.presentationEpoch,
      snapshot: null,
      commandPending: false,
      connectionFailed: false
    })
  }
  const visible = hasSameSource
    ? state
    : {
        presentationEpoch: state.presentationEpoch,
        snapshot: null,
        commandPending: false,
        connectionFailed: false
      }
  return {
    presentationEpoch: visible.presentationEpoch,
    snapshot: visible.snapshot,
    commandPending: visible.commandPending,
    connectionFailed: visible.connectionFailed,
    onIntent,
    resynchronize
  }
}
