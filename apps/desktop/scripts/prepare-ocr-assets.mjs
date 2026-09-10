import { copyFile, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export const OCR_ASSETS = [
  { source: 'tesseract.js/dist/worker.min.js', target: 'worker.min.js' },
  {
    source: 'tesseract.js-core/tesseract-core-lstm.wasm.js',
    target: 'core/tesseract-core-lstm.wasm.js'
  },
  {
    source: 'tesseract.js-core/tesseract-core-lstm.wasm',
    target: 'core/tesseract-core-lstm.wasm'
  },
  {
    source: 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
    target: 'core/tesseract-core-simd-lstm.wasm.js'
  },
  {
    source: 'tesseract.js-core/tesseract-core-simd-lstm.wasm',
    target: 'core/tesseract-core-simd-lstm.wasm'
  },
  {
    source: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    target: 'core/tesseract-core-relaxedsimd-lstm.wasm.js'
  },
  {
    source: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm',
    target: 'core/tesseract-core-relaxedsimd-lstm.wasm'
  },
  {
    source: '@tesseract.js-data/kor/4.0.0/kor.traineddata.gz',
    target: 'lang/kor.traineddata.gz'
  },
  {
    source: '@tesseract.js-data/eng/4.0.0/eng.traineddata.gz',
    target: 'lang/eng.traineddata.gz'
  }
]

const defaultDestination = fileURLToPath(new URL('../src/frontend/public/ocr', import.meta.url))

/**
 * @param {string} destination
 * @returns {Promise<void>}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
export async function prepareOcrAssets(destination = defaultDestination) {
  await rm(destination, { recursive: true, force: true })

  await Promise.all(
    OCR_ASSETS.map(async ({ source, target }) => {
      const targetPath = join(destination, target)
      await mkdir(dirname(targetPath), { recursive: true })
      await copyFile(require.resolve(source), targetPath)
    })
  )
}

const invokedPath = process.argv[1]
const hasInvokedPath = invokedPath != null
if (hasInvokedPath) {
  const isInvokedPathNonempty = invokedPath !== ''
  if (isInvokedPathNonempty) {
    const isDirectInvocation = import.meta.url === pathToFileURL(resolve(invokedPath)).href
    if (isDirectInvocation) {
      await prepareOcrAssets()
    }
  }
}
