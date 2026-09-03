import { describe, expect, it } from 'vitest'
import { ocrAssetUrls } from './ocr'

describe('OCR asset 경로', () => {
  it('renderer document 기준의 public asset URL을 반환한다', () => {
    expect(ocrAssetUrls('file:///app/out/frontend/index.html')).toEqual({
      workerPath: 'file:///app/out/frontend/ocr/worker.min.js',
      corePath: 'file:///app/out/frontend/ocr/core',
      langPath: 'file:///app/out/frontend/ocr/lang'
    })
  })
})
