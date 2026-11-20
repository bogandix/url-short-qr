import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shortener/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'setup/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
})
