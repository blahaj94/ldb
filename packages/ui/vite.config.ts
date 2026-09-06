import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { uiNotices } from './build/notices.ts'

function isExternal(id: string) {
  const isSeed = id.startsWith('@seed-design/')
  const isReact = id === 'react' || id.startsWith('react/')
  const isReactDom = id === 'react-dom' || id.startsWith('react-dom/')
  const isOfficialIcon = id.startsWith('@karrotmarket/react-monochrome-icon')
  const isPeerOrIcon = isSeed || isReact || isReactDom || isOfficialIcon
  return isPeerOrIcon
}

export default defineConfig({
  plugins: [react(), uiNotices()],
  build: {
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: 'index' },
    rolldownOptions: { external: isExternal }
  }
})
