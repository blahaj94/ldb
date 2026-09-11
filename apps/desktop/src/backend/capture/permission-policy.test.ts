import { describe, expect, it, vi } from 'vitest'
import { registerCapturePermissions } from './permission-policy'

const documentUrl = 'file:///fixture/index.html'

type PermissionFixture = {
  check: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  frame: { url: string; detached: boolean; isDestroyed: ReturnType<typeof vi.fn> }
  webContents: {
    mainFrame: { url: string; detached: boolean; isDestroyed: ReturnType<typeof vi.fn> }
    isDestroyed: ReturnType<typeof vi.fn>
  }
  window: {
    webContents: PermissionFixture['webContents']
    isDestroyed: ReturnType<typeof vi.fn>
  }
  auth: { captureGeneration: ReturnType<typeof vi.fn> }
}

function createFixture(): PermissionFixture {
  const check = vi.fn()
  const request = vi.fn()
  const frame = { url: documentUrl, detached: false, isDestroyed: vi.fn(() => false) }
  const webContents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false)
  }
  const window = {
    webContents,
    isDestroyed: vi.fn(() => false)
  }
  const session = {
    setPermissionCheckHandler: check,
    setPermissionRequestHandler: request
  }
  const auth = { captureGeneration: vi.fn<() => number | null>(() => 1) }
  registerCapturePermissions(session)
  return { check, request, frame, webContents, window, auth }
}

function ask(
  fixture: ReturnType<typeof createFixture>,
  changes: Record<string, unknown> = {}
): ReturnType<typeof vi.fn> {
  const callback = vi.fn()
  const handler = fixture.request.mock.calls[0][0]
  handler(fixture.webContents, 'media', callback, {
    isMainFrame: true,
    requestingUrl: documentUrl,
    mediaTypes: [],
    ...changes
  })
  return callback
}

describe('capture permission policy', () => {
  it('keeps product media request and check explicitly denied', () => {
    const fixture = createFixture()

    expect(ask(fixture)).toHaveBeenCalledExactlyOnceWith(false)
    expect(fixture.check.mock.calls[0][0]()).toBe(false)
  })

  it.each([
    { isMainFrame: false },
    { requestingUrl: 'about:blank' },
    { mediaTypes: ['audio'] },
    { permission: 'notifications' },
    { contents: 'other' }
  ])('rejects a request outside the approved boundary: %j', (changes) => {
    const fixture = createFixture()
    const callback = vi.fn()
    const handler = fixture.request.mock.calls[0][0]
    const contents = changes.contents === 'other' ? {} : fixture.webContents
    const permission = changes.permission ?? 'media'
    handler(contents, permission, callback, {
      isMainFrame: true,
      requestingUrl: documentUrl,
      mediaTypes: [],
      ...changes
    })

    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does not grant media permission while auth generation is unavailable', () => {
    const fixture = createFixture()
    fixture.auth.captureGeneration.mockReturnValue(null)

    expect(ask(fixture)).toHaveBeenCalledExactlyOnceWith(false)
  })
})
