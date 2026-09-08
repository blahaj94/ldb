import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AuthCaptureContext } from '../auth/capture-context'
import { CaptureSearch, emptySearchSlots, type SearchView } from './capture-search'

type CharacterSearch = SearchView & {
  begin: (signal: AbortSignal) => Promise<string | null>
  end: () => void
  observe: (input: { slot: number; nickname: string | null }) => void
  retry: (slot: number) => void
}

export function useCharacterSearch(onInvalidated: () => void): CharacterSearch {
  const auth = useContext(AuthCaptureContext)
  const authRef = useRef(auth)
  const invalidatedRef = useRef(onInvalidated)
  useLayoutEffect(() => {
    authRef.current = auth
    invalidatedRef.current = onInvalidated
  }, [auth, onInvalidated])
  const bridgeRef = useRef<CaptureSearch | null>(null)
  const [view, setView] = useState<SearchView>({
    slots: emptySearchSlots(),
    retryPending: [false, false, false, false],
    connectionFailed: false
  })
  const api = window.search
  const notify = window.api.notifyStableNicknameDetected

  useEffect(() => {
    let active = true
    const bridge = new CaptureSearch({
      api,
      notify,
      onChange: (value) => {
        if (active) {
          setView(value)
        }
      },
      onInvalidated: () => invalidatedRef.current(),
      resynchronizeAuth: () => authRef.current.resynchronize()
    })
    bridgeRef.current = bridge
    bridge.connect()
    return () => {
      active = false
      bridgeRef.current = null
      bridge.dispose()
    }
  }, [api, notify])

  const begin = useCallback(async (signal: AbortSignal): Promise<string | null> => {
    const snapshot = authRef.current.snapshot
    const isSignedIn = snapshot?.phase === 'signedIn'
    const bridge = bridgeRef.current
    const canBegin = isSignedIn && bridge != null
    if (!canBegin) {
      return null
    }
    return bridge.begin({ auth: snapshot, signal })
  }, [])
  const end = useCallback((): void => bridgeRef.current?.end(), [])
  const observe = useCallback((input: { slot: number; nickname: string | null }): void => {
    bridgeRef.current?.observe(input)
  }, [])
  const retry = useCallback((slot: number): void => {
    void bridgeRef.current?.retry(slot)
  }, [])
  return { ...view, begin, end, observe, retry }
}
