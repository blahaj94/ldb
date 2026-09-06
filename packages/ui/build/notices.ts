import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiRoot = fileURLToPath(new URL('../', import.meta.url))

type BundleContext = {
  getModuleIds(): IterableIterator<string>
  emitFile(asset: { type: 'asset'; fileName: string; source: string }): string
}

// 각 build 입력 graph의 dependency 고지와 module provenance를 보존한다.
// Tree-shaking 전 입력도 포함해 고지와 중복 사본 검사를 보수적으로 수행한다.
// Vite 7(Electron)과 Vite 8에서 공통으로 제공하는 Rollup hook만 사용한다.
export function uiNotices() {
  return {
    name: 'ldb-ui-notices',
    generateBundle(this: BundleContext) {
      for (const name of readdirSync(join(uiRoot, 'notices'))) {
        this.emitFile({
          type: 'asset',
          fileName: `notices/${name}`,
          source: readFileSync(join(uiRoot, 'notices', name), 'utf8')
        })
      }

      this.emitFile({
        type: 'asset',
        fileName: 'notices/seed-provenance.json',
        source: readFileSync(join(uiRoot, 'seed-provenance.json'), 'utf8')
      })

      const packages = new Map<string, { name: string; version: string; license: string; modules: string[] }>()
      for (const moduleId of this.getModuleIds()) {
        const isDependency = moduleId.includes('/node_modules/')
        if (!isDependency) continue
        const sourcePath = moduleId.split('?')[0]
        let directory = dirname(sourcePath)
        let hasManifest = existsSync(join(directory, 'package.json'))
        while (!hasManifest) {
          const parent = dirname(directory)
          const isFilesystemRoot = parent === directory
          if (isFilesystemRoot) throw new Error('Bundled dependency has no package manifest')
          directory = parent
          hasManifest = existsSync(join(directory, 'package.json'))
        }
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        const isFirstModule = !packages.has(directory)
        if (isFirstModule) {
          packages.set(directory, {
            name: manifest.name,
            version: manifest.version,
            license: manifest.license,
            modules: []
          })
        }
        packages.get(directory)?.modules.push(relative(directory, sourcePath))
      }

      const thirdParty: string[] = []
      for (const [directory, metadata] of packages) {
        const noticeNames = readdirSync(directory).filter((name) => {
          const isNotice = /^(licen[cs]e|notice|copying)(\.|$)/i.test(name)
          return isNotice
        })
        thirdParty.push(`${metadata.name}@${metadata.version} (${metadata.license})`)
        for (const name of noticeNames) {
          thirdParty.push(`${basename(name)}\n${readFileSync(join(directory, name), 'utf8')}`)
        }
      }
      this.emitFile({ type: 'asset', fileName: 'notices/THIRD-PARTY.txt', source: thirdParty.join('\n\n') })
      this.emitFile({
        type: 'asset',
        fileName: 'notices/bundle-modules.json',
        source: JSON.stringify([...packages.values()], null, 2)
      })
    }
  }
}
