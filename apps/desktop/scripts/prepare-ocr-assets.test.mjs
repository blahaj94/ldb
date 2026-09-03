import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OCR_ASSETS, prepareOcrAssets } from './prepare-ocr-assets.mjs'

describe('OCR public asset 준비', () => {
  it('worker, LSTM core와 한영 language data를 모두 복사한다', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'ldb-ocr-assets-'))

    try {
      await prepareOcrAssets(destination)

      for (const { target } of OCR_ASSETS) {
        const assetPath = join(destination, target)
        await access(assetPath)
        expect((await stat(assetPath)).size).toBeGreaterThan(0)
      }
    } finally {
      await rm(destination, { recursive: true, force: true })
    }
  })
})
