import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { chromium } from 'playwright'

const sourcePath = fileURLToPath(new URL('./workflow.mmd', import.meta.url))
const outputDirectory = new URL('../.artifacts/', import.meta.url)
const outputPath = fileURLToPath(new URL('workflow.png', outputDirectory))
const source = await readFile(sourcePath, 'utf8')
const rendered = renderMermaidSVG(source, {
  bg: '#ffffff',
  fg: '#24344b',
  accent: '#416da8',
  line: '#8395aa',
  muted: '#50647d',
  surface: '#f1f5fa',
  border: '#b4c3d3',
  font: 'Apple SD Gothic Neo',
  padding: 28,
  nodeSpacing: 26,
  layerSpacing: 32
})
const svg = rendered.replace(/@import[^;]+;/g, '')
const html = renderPage(svg)

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 2400, height: 1800 },
    deviceScaleFactor: 2
  })
  await page.setContent(html)
  await page.evaluate('document.fonts.ready')
  await page.locator('main').screenshot({ path: outputPath })
} finally {
  await browser.close()
}

console.log(`PNG: ${outputPath}`)
console.log(`Mermaid: ${sourcePath}`)

function renderPage(svg) {
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><style>
body { margin: 0; background: #fff; color: #24344b; font-family: 'Apple SD Gothic Neo', sans-serif; }
main { display: inline-block; padding: 36px 40px 28px; }
h1 { font-size: 30px; margin: 0 0 12px; }
p { font-size: 15px; line-height: 1.6; margin: 0; }
header { border-bottom: 1px solid #d7e0ec; padding-bottom: 20px; margin-bottom: 14px; }
svg { display: block; }
footer { border-top: 1px solid #d7e0ec; padding-top: 16px; margin-top: 16px; font-size: 14px; }
</style></head><body><main>
<header><h1>작업을 고르고, 에이전트에게 맡기고, 완료하기</h1>
<p>“이 Project의 [카드 이름]을 진행해. Issue로 나누고 구현과 검증을 마친 뒤 PR까지 만들어줘.”</p></header>
${svg}
<footer>현재 실행 기준: docs/rules/task-planning.md | 원본: scripts/workflow.mmd</footer>
</main></body></html>`
  return html
}
