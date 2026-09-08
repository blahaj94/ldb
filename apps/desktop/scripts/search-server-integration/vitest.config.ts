import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../', import.meta.url)),
    include: ['scripts/search-server-integration/*.integration.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 240_000,
    server: { deps: { external: [/\/api\//] } }
  }
})
