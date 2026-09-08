import '@seed-design/css/base.css'
import '@ldb/ui/foundation.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AuthApi } from '../../preload/common/types/auth'
import { AuthBridge } from '../src/auth/AuthBridge'

declare global {
  interface Window {
    auth: AuthApi
  }
}
const root = document.getElementById('root')
const hasRoot = root != null
if (!hasRoot) {
  throw new Error('Auth fixture root missing')
}
createRoot(root).render(
  <StrictMode>
    <AuthBridge api={window.auth} />
  </StrictMode>
)
