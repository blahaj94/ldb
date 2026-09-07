import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../../../packages/ui/build/notices'

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve('scripts/auth-bridge-fixture/main.ts'), formats: ['cjs'] },
      outDir: 'out/auth-bridge-fixture/main',
      rollupOptions: { output: { entryFileNames: 'main.cjs' } }
    }
  },
  preload: {
    build: {
      lib: { entry: resolve('scripts/auth-bridge-fixture/preload.ts'), formats: ['cjs'] },
      outDir: 'out/auth-bridge-fixture/preload',
      rollupOptions: { output: { entryFileNames: 'preload.cjs' } }
    }
  },
  renderer: {
    root: resolve('src/frontend/auth-bridge-fixture'),
    plugins: [react(), seedDesignPlugin(), uiNotices()],
    resolve: {
      alias: [{ find: /^@ldb\/ui$/, replacement: resolve('../../packages/ui/src/index.tsx') }]
    },
    build: {
      outDir: resolve('out/auth-bridge-fixture/renderer'),
      rollupOptions: { input: resolve('src/frontend/auth-bridge-fixture/index.html') }
    }
  }
})
