import { contextBridge } from 'electron'
import * as capture from './api/capture'
import * as auth from './api/auth'
import * as search from './api/search'

contextBridge.exposeInMainWorld('api', capture)
contextBridge.exposeInMainWorld('auth', auth)

contextBridge.exposeInMainWorld('search', search)
