import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const ocrLanguageAssets: Record<string, string> = {
  '/eng.traineddata.gz': resolve('node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'),
  '/kor.traineddata.gz': resolve('node_modules/@tesseract.js-data/kor/4.0.0/kor.traineddata.gz')
}

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve('src/backend/main.ts')
      },
      outDir: 'out/backend'
    }
  },
  preload: {},
  renderer: {
    root: resolve('src/frontend'),
    build: {
      rollupOptions: {
        input: resolve('src/frontend/index.html'),
        output: {
          assetFileNames: 'assets/[name][extname]'
        }
      },
      outDir: 'out/frontend'
    },
    resolve: {
      alias: {
        '@frontend': resolve('src/frontend/src')
      }
    },
    plugins: [
      react(),
      {
        name: 'serve-local-ocr-language-data',
        configureServer(server) {
          server.middlewares.use('/ocr-assets', (request, response, next) => {
            const assetPath = ocrLanguageAssets[request.url ?? '']
            if (!assetPath) return next()

            response.setHeader('Content-Type', 'application/gzip')
            createReadStream(assetPath).on('error', next).pipe(response)
          })
        }
      }
    ]
  }
})
