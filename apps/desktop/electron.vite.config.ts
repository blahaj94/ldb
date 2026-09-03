import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve('src/backend/main.ts')
      },
      outDir: 'out/backend'
    }
  },
  preload: {},
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
      alias: {
        '@frontend': resolve('src/frontend/src')
      }
    },
    plugins: [react()]
  }
})
