import { describe, expect, it } from 'vitest'
import { assetDirectory } from './ocr'

describe('OCR asset 경로', () => {
  it('Vite dev server의 root-relative asset을 renderer URL 기준으로 해석한다', () => {
    expect(
      assetDirectory(
        ['/@fs/project/node_modules/tesseract.js/dist/worker.min.js'],
        'http://127.0.0.1:5173/'
      )
    ).toBe('http://127.0.0.1:5173/@fs/project/node_modules/tesseract.js/dist')
  })
})
