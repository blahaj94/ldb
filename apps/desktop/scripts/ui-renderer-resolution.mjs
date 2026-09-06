import assert from 'node:assert/strict'
import { resolveConfig } from 'electron-vite'
import { createServer } from 'vite'

// electron-vite --rendererOnly도 Electron을 시작하므로, 공개 config API만 재사용한다.
process.env.NODE_ENV_ELECTRON_VITE = 'development'
const resolved = await resolveConfig({}, 'serve', 'development')
const renderer = resolved.config?.renderer
assert.ok(renderer, 'Actual electron-vite renderer config must exist')
const server = await createServer({
  ...renderer,
  server: { ...renderer.server, host: '127.0.0.1', port: 0 }
})

// HTTP assertion과 이 child의 종료는 부모 regression test가 소유한다.
await server.listen()
server.printUrls()
