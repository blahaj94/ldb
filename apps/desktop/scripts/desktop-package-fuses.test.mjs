import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(new URL('../package.json', import.meta.url))
const electronBuilderEntry = require.resolve('electron-builder')
const electronBuilderPackageDir = dirname(dirname(electronBuilderEntry))
const appBuilderConfigModulePath = join(
  dirname(electronBuilderPackageDir),
  'app-builder-lib',
  'out',
  'util',
  'config',
  'config.js'
)

const desktopProjectDir = fileURLToPath(new URL('..', import.meta.url))
const debugLogger = {
  isEnabled: false,
  add() {}
}

describe('desktop package fuse configuration', () => {
  it('loads and validates the packaging configuration with app-builder-lib', async () => {
    const { getConfig, validateConfiguration } = await import(
      pathToFileURL(appBuilderConfigModulePath).href
    )
    const configuration = await getConfig(desktopProjectDir, null, null)

    await validateConfiguration(configuration, debugLogger)

    expect(configuration.electronFuses).toEqual({
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false
    })
  })
})
