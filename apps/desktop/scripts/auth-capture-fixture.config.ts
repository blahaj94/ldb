import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../../../packages/ui/build/notices'

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve('scripts/auth-capture-fixture/main.ts'), formats: ['cjs'] },
      outDir: 'out/auth-capture-fixture/main',
      rollupOptions: { output: { entryFileNames: 'main.cjs' } }
    }
  },
  preload: {
    build: {
      lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'] },
      outDir: 'out/auth-capture-fixture/preload',
      rollupOptions: { output: { entryFileNames: 'preload.cjs' } }
    }
  },
  renderer: {
    root: resolve('src/frontend/auth-capture-fixture'),
    publicDir: resolve('src/frontend/public'),
    plugins: [react(), seedDesignPlugin(), uiNotices()],
    resolve: {
      alias: [{ find: /^@ldb\/ui$/, replacement: resolve('../../packages/ui/src/index.tsx') }]
    },
    build: {
      outDir: resolve('out/auth-capture-fixture/renderer'),
      rollupOptions: {
        input: {
          index: resolve('src/frontend/auth-capture-fixture/index.html'),
          source: resolve('src/frontend/auth-capture-fixture/source.html')
        }
      }
    }
  }
})
