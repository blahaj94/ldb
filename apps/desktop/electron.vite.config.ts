import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../../packages/ui/build/notices.ts'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve('src/backend/main.ts')
      },
      outDir: 'out/backend'
    }
  },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    root: resolve('src/frontend'),
    build: {
      rollupOptions: {
        input: resolve('src/frontend/index.html'),
        output: {
          assetFileNames: 'assets/[name][extname]'
        }
      },
      outDir: 'out/frontend'
    },
    resolve: {
      alias: [
        { find: '@frontend', replacement: resolve('src/frontend/src') },
        { find: /^@ldb\/ui$/, replacement: resolve('../../packages/ui/src/index.tsx') }
      ]
    },
    plugins: [react(), seedDesignPlugin(), uiNotices()]
  }
})
