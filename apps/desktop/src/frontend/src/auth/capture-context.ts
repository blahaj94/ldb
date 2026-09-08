import { createContext } from 'react'
import type { AuthSnapshot } from '../../../preload/common/types/auth'

export const AuthCaptureContext = createContext<{
  snapshot: AuthSnapshot | null
  resynchronize: () => void
}>({ snapshot: null, resynchronize: () => {} })
