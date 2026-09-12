import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/windows-security-fixture/native.fixture.ts'],
    fileParallelism: false,
    disableConsoleIntercept: true,
    testTimeout: 60_000
  }
})
