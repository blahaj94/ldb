import { createWorker, PSM, type Worker } from 'tesseract.js'
import workerPath from 'tesseract.js/dist/worker.min.js?url'
import coreLstmPath from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url'
import coreLstmWasmPath from 'tesseract.js-core/tesseract-core-lstm.wasm?url'
import coreRelaxedSimdLstmPath from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js?url'
import coreRelaxedSimdLstmWasmPath from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm?url'
import coreSimdLstmPath from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'
import coreSimdLstmWasmPath from 'tesseract.js-core/tesseract-core-simd-lstm.wasm?url'
import engPath from '@tesseract.js-data/eng/4.0.0/eng.traineddata.gz?url'
import korPath from '@tesseract.js-data/kor/4.0.0/kor.traineddata.gz?url'

const coreAssets = [
  coreLstmPath,
  coreLstmWasmPath,
  coreRelaxedSimdLstmPath,
  coreRelaxedSimdLstmWasmPath,
  coreSimdLstmPath,
  coreSimdLstmWasmPath
]
const rendererUrl = typeof location === 'undefined' ? 'http://localhost/' : location.href
const corePath = assetDirectory(coreAssets, rendererUrl)
const langPath = import.meta.env.DEV
  ? new URL('/ocr-assets', rendererUrl).toString().replace(/\/$/, '')
  : assetDirectory([engPath, korPath], rendererUrl)

export async function createPartyOcrWorker(): Promise<Worker> {
  const worker = await createWorker(['kor', 'eng'], 1, {
    cacheMethod: 'none',
    corePath,
    langPath,
    workerBlobURL: false,
    workerPath
  })

  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
  return worker
}

export function assetDirectory(assetPaths: string[], baseUrl = rendererUrl): string {
  const assetUrls = assetPaths.map((assetPath) => new URL(assetPath, baseUrl).toString())
  const directory = new URL('.', assetUrls[0]).toString().replace(/\/$/, '')
  if (!assetUrls.every((assetUrl) => assetUrl.startsWith(`${directory}/`))) {
    throw new Error('OCR assets must be emitted into one directory')
  }

  return directory
}
