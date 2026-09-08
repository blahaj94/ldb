import { PARTY_MANA_COLOR, PARTY_SLOTS } from '../src/capture/party'

const canvas = document.getElementById('source')
const isCanvas = canvas instanceof HTMLCanvasElement
if (!isCanvas) {
  throw new Error('Synthetic source canvas missing')
}
const context = canvas.getContext('2d')
const hasContext = context != null
if (!hasContext) {
  throw new Error('Synthetic source context missing')
}
context.fillStyle = 'white'
context.fillRect(0, 0, canvas.width, canvas.height)
for (const slot of PARTY_SLOTS) {
  context.fillStyle = 'black'
  context.font = '14px monospace'
  context.textBaseline = 'top'
  context.fillText('ALICE', slot.nickname.x + 2, slot.nickname.y + 1)
  context.fillStyle = `rgb(${PARTY_MANA_COLOR.join(',')})`
  context.fillRect(slot.mana.x, slot.mana.y, slot.mana.width, slot.mana.height)
}
