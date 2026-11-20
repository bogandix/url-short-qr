import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shortener/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) },
  },
  test: { include: ['test/**/*.integration.test.ts'], testTimeout: 60_000, fileParallelism: false },
})
