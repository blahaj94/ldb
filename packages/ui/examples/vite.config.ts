import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../build/notices.ts'

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [react(), seedDesignPlugin(), uiNotices()],
  resolve: {
    alias: [
      {
        find: /^@ldb\/ui$/,
        replacement: fileURLToPath(new URL('../src/index.tsx', import.meta.url))
      }
    ]
  },
  build: { outDir: '../dist-examples', emptyOutDir: true }
})
