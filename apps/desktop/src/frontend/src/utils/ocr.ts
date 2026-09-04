import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'

export async function createPartyOcrWorker(): Promise<Worker> {
  const { workerPath, corePath, langPath } = ocrAssetUrls()
  const worker = await createWorker(['kor', 'eng'], OEM.LSTM_ONLY, {
    cacheMethod: 'none',
    corePath,
    langPath,
    workerBlobURL: false,
    workerPath
  })

  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
  return worker
}

export function ocrAssetUrls(baseUrl = document.baseURI): {
  workerPath: string
  corePath: string
  langPath: string
} {
  const root = new URL('ocr/', baseUrl)
  return {
    workerPath: new URL('worker.min.js', root).toString(),
    corePath: new URL('core', root).toString(),
    langPath: new URL('lang', root).toString()
  }
}
