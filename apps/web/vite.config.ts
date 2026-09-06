import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../../packages/ui/build/notices.ts'

export default defineConfig({
  plugins: [react(), seedDesignPlugin(), uiNotices()],
  resolve: {
    alias: [{ find: /^@ldb\/ui$/, replacement: fileURLToPath(new URL('../../packages/ui/src/index.tsx', import.meta.url)) }]
  }
})
