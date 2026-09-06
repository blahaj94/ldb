import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { seedDesignPlugin } from '@seed-design/vite-plugin'
import { uiNotices } from '../../packages/ui/build/notices.ts'

export default defineConfig({
  plugins: [react(), seedDesignPlugin(), uiNotices()]
})
