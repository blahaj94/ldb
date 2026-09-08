import '@seed-design/css/base.css'
import '@ldb/ui/foundation.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Fixture } from './Fixture'

const root = document.getElementById('root')
const hasRoot = root != null
if (!hasRoot) {
  throw new Error('Auth fixture root missing')
}
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>
)
