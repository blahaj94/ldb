import '@seed-design/css/base.css'
import '@ldb/ui/foundation.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { runStandaloneOcr } from './standalone-ocr'

declare global {
  interface Window {
    runFixtureOcr: typeof runStandaloneOcr
  }
}

window.runFixtureOcr = runStandaloneOcr

const root = document.getElementById('root')
const hasRoot = root != null
if (!hasRoot) throw new Error('Capture fixture root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
