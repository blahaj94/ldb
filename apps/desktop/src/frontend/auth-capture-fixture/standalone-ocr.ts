import { createPartyOcrWorker } from '../src/capture/ocr'
import { normalizeNickname } from '../src/capture/recognition'

export async function runStandaloneOcr(): Promise<{ matched: boolean; terminated: boolean }> {
  const canvas = document.createElement('canvas')
  canvas.width = 420
  canvas.height = 72
  const context = canvas.getContext('2d')
  const hasContext = context != null
  if (!hasContext) {
    throw new Error('Synthetic OCR canvas missing')
  }
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = 'black'
  context.font = '56px monospace'
  context.textBaseline = 'top'
  context.fillText('ALICE', 8, 4)
  const worker = await createPartyOcrWorker()
  let matched = false
  try {
    const result = await worker.recognize(canvas)
    matched = normalizeNickname(result.data.text) === 'ALICE'
  } finally {
    await worker.terminate()
  }
  return { matched, terminated: true }
}
