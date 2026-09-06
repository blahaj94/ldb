import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['../../packages/ui/test/setup.ts'],
    server: { deps: { inline: [/@seed-design\//] } }
  }
})
