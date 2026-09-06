import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, outputPath] = process.argv.slice(2)
const isLibrary = mode === 'library'
const isConsumer = mode === 'consumer'
assert.ok(isLibrary || isConsumer, 'Use library|consumer and an output directory')
const output = resolve(outputPath)
const uiRoot = fileURLToPath(new URL('../', import.meta.url))
const files = await readdir(output, { recursive: true })
const graph = JSON.parse(await readFile(resolve(output, 'notices/bundle-modules.json'), 'utf8'))
const cssFiles = files.filter((file) => file.endsWith('.css'))

for (const name of await readdir(resolve(uiRoot, 'notices'))) {
  assert.equal(
    await readFile(resolve(output, 'notices', name), 'utf8'),
    await readFile(resolve(uiRoot, 'notices', name), 'utf8'),
    `Preserved notice: ${name}`
  )
}
const provenanceText = await readFile(resolve(uiRoot, 'seed-provenance.json'), 'utf8')
assert.equal(await readFile(resolve(output, 'notices/seed-provenance.json'), 'utf8'), provenanceText)
for (const source of JSON.parse(provenanceText).files) {
  const bytes = await readFile(resolve(uiRoot, source.local))
  const hash = createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash, source.localSha256 ?? source.sha256, source.local)
}

if (isLibrary) {
  assert.equal(graph.length, 0, 'Library must externalize all runtime dependencies')
  assert.equal(cssFiles.length, 0, 'Library must not emit CSS')
  const declarations = files.filter((file) => file.endsWith('.d.ts'))
  for (const declaration of declarations) {
    const types = await readFile(resolve(output, declaration), 'utf8')
    const hasPrivateOrNodeType = /node:|NodeJS|\.pnpm/.test(types)
    assert.equal(hasPrivateOrNodeType, false, `Portable browser declaration: ${declaration}`)
  }
  const code = await readFile(resolve(output, 'index.js'), 'utf8')
  for (const external of ['@seed-design/react', 'react', 'react/jsx-runtime']) {
    assert.ok(code.includes(`from "${external}"`), `External import: ${external}`)
  }
} else {
  const expectedVersions = {
    react: '19.2.8',
    'react-dom': '19.2.8',
    '@seed-design/react': '2.4.1',
    '@seed-design/css': '2.7.0'
  }
  for (const [name, version] of Object.entries(expectedVersions)) {
    const copies = graph.filter((dependency) => dependency.name === name)
    assert.equal(copies.length, 1, `Single bundled copy: ${name}`)
    assert.equal(copies[0].version, version, name)
  }
  const seedCss = graph.find((dependency) => dependency.name === '@seed-design/css')
  const baseImports = seedCss.modules.filter((file) => file === 'base.css')
  assert.equal(baseImports.length, 1, 'Consumer must import base.css once')
  assert.equal(cssFiles.length, 1, 'Consumer must emit one combined stylesheet')
  const licenses = await readFile(resolve(output, 'notices/THIRD-PARTY.txt'), 'utf8')
  assert.ok(licenses.includes('MIT License'), 'Bundled dependency license text retained')
}

console.log(`${mode}: source/notice hashes, dependency boundary and CSS checks passed`)
