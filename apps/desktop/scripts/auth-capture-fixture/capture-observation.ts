import { ipcMain, type BrowserWindow } from 'electron'
import type { AuthClock, AuthCoordinator } from '../../src/backend/auth/types'
import { registerCaptureIpc, registerCaptureWindow } from '../../src/backend/capture/ipc-handler'
import { parseSearchObservation } from '../../src/backend/search/commands'
import { parseSearchResult } from '../../src/preload/common/search/snapshot'

export type CaptureObservation = {
  displayRequests: number
  displayAllowed: number
  nicknameInvokes: number
  nicknameAccepted: number
  nicknameMatchedSlots: number
}

type ParsedObservation = NonNullable<ReturnType<typeof parseSearchObservation>>
type SuccessfulSearchResult = Extract<
  NonNullable<ReturnType<typeof parseSearchResult>>,
  { ok: true }
>

export function isAcceptedParsedObservation(
  observation: ParsedObservation,
  result: SuccessfulSearchResult
): boolean {
  const slot = result.snapshot.slots[observation.slot]
  const hasSameCapture = result.snapshot.captureId === observation.captureId
  const hasSameSlot = slot.slot === observation.slot
  const hasSameRevision = slot.observationRevision === observation.observationRevision
  const hasSameNickname = slot.nickname === observation.nickname
  const hasRequestId = slot.requestId != null
  if (hasRequestId) {
    const isRequestActive = slot.state !== 'idle'
    const isAccepted =
      hasSameCapture &&
      hasSameSlot &&
      hasSameRevision &&
      hasSameNickname &&
      hasRequestId &&
      isRequestActive
    return isAccepted
  }
  return false
}

function isAcceptedObservation({
  value,
  response
}: {
  value: unknown
  response: unknown
}): boolean {
  const observation = parseSearchObservation([value])
  const result = parseSearchResult(response)
  const hasObservation = observation != null
  const isSuccessful = result?.ok === true
  const canCompare = hasObservation && isSuccessful
  if (!canCompare) {
    return false
  }
  return isAcceptedParsedObservation(observation, result)
}

export function syntheticSlotMask(value: unknown): number {
  const isObject = value != null && typeof value === 'object'
  if (!isObject) {
    return 0
  }
  const { slot, nickname } = value as { slot?: unknown; nickname?: unknown }
  const isSlotNumber = typeof slot === 'number'
  const isExpectedNickname = nickname === 'ALICE'
  if (isSlotNumber) {
    const isSlotInteger = Number.isInteger(slot)
    if (isSlotInteger) {
      const isSlotInRange = slot >= 0 && slot < 4
      const isExpectedSlot = isSlotInRange && isExpectedNickname
      return isExpectedSlot ? 1 << slot : 0
    }
  }
  return 0
}

export function registerObservedCapture(
  coordinator: AuthCoordinator,
  window: BrowserWindow,
  documentUrl: string,
  runtime?: { apiOrigin: string; fetch: typeof fetch; clock: AuthClock }
): { counts: CaptureObservation; dispose: () => void } {
  const counts = {
    displayRequests: 0,
    displayAllowed: 0,
    nicknameInvokes: 0,
    nicknameAccepted: 0,
    nicknameMatchedSlots: 0
  }
  const session = window.webContents.session
  const originalDisplay = session.setDisplayMediaRequestHandler
  const originalHandle = ipcMain.handle
  // 실제 제품 handler를 그대로 호출하며 고정 counter만 관측한다.
  session.setDisplayMediaRequestHandler = (handler, options) => {
    const hasHandler = handler != null
    if (!hasHandler) {
      originalDisplay.call(session, handler, options)
      return
    }
    originalDisplay.call(
      session,
      (request, callback) => {
        counts.displayRequests += 1
        handler(request, (streams) => {
          const hasStreams = streams != null
          const isAllowed = hasStreams && streams.video != null
          if (isAllowed) {
            counts.displayAllowed += 1
          }
          callback(streams)
        })
      },
      options
    )
  }
  ipcMain.handle = (channel, listener) => {
    const isNickname = channel === 'notifyStableNicknameDetected'
    if (!isNickname) {
      originalHandle.call(ipcMain, channel, listener)
      return
    }
    originalHandle.call(ipcMain, channel, (event, ...args) => {
      counts.nicknameInvokes += 1
      const result = listener(event, ...args)
      return Promise.resolve(result).then((response: unknown) => {
        const isAccepted = isAcceptedObservation({ value: args[0], response })
        if (isAccepted) {
          counts.nicknameAccepted += 1
          counts.nicknameMatchedSlots |= syntheticSlotMask(args[0])
        }
        return response
      })
    })
  }
  try {
    const dispose = registerCaptureIpc(coordinator, runtime)
    registerCaptureWindow(window, documentUrl)
    return { counts, dispose }
  } finally {
    session.setDisplayMediaRequestHandler = originalDisplay
    ipcMain.handle = originalHandle
  }
}
