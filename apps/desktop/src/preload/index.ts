import { contextBridge } from 'electron'
import * as capture from './api/capture'
import * as auth from './api/auth'

contextBridge.exposeInMainWorld('api', capture)
contextBridge.exposeInMainWorld('auth', auth)
