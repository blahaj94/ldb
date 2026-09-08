declare global {
  interface Window {
    api: typeof import('./api/capture')
    auth: typeof import('./api/auth')
    search: typeof import('./api/search')
  }
}

export {}
