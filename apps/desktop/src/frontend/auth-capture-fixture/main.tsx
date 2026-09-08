import '@seed-design/css/base.css'
import '@ldb/ui/foundation.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { runStandaloneOcr } from './standalone-ocr'
import { capturePartyNicknameCrops } from '../src/capture/party'

declare global {
  interface Window {
    runFixtureOcr: typeof runStandaloneOcr
    inspectFixtureFrame: (video: HTMLVideoElement) => {
      frameWidth: number
      frameHeight: number
      allSlotsPresent: boolean
    }
  }
}

window.runFixtureOcr = runStandaloneOcr
window.inspectFixtureFrame = (video) => ({
  frameWidth: video.videoWidth,
  frameHeight: video.videoHeight,
  allSlotsPresent: capturePartyNicknameCrops(video).every((crop) => {
    const isPresent = crop != null
    return isPresent
  })
})

const root = document.getElementById('root')
const hasRoot = root != null
if (!hasRoot) throw new Error('Capture fixture root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
