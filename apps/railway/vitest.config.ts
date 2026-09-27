import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': resolve(import.meta.dirname, 'src/cloudflare-shim.ts') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 15_000 },
})
