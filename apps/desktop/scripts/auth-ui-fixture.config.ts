import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../../../packages/ui/build/notices'

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('../src/frontend/auth-fixture/', import.meta.url)),
  plugins: [react(), seedDesignPlugin(), uiNotices()],
  resolve: {
    alias: [
      {
        find: /^@ldb\/ui$/,
        replacement: fileURLToPath(new URL('../../../packages/ui/src/index.tsx', import.meta.url))
      }
    ]
  },
  build: {
    outDir: fileURLToPath(new URL('../out/auth-ui-fixture/', import.meta.url)),
    emptyOutDir: true
  }
})
