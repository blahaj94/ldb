import { contextBridge } from 'electron'
import * as auth from '../../src/preload/api/auth'

contextBridge.exposeInMainWorld('auth', auth)
