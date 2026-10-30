import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'progression-event-text',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!importer || !/[\\/]?progression-events[\\/].*\.json$/.test(id)) return null
      const resolved = await this.resolve(id, importer, { skipSelf: true })
      // Keep the virtual id from ending in `.json`, or Vite's JSON transform parses
      // our string-export module as JSON a second time.
      return resolved ? `\0progression-event:${resolved.id}.text` : null
    },
    load(id) {
      if (id.startsWith('\0progression-event:')) {
        const file = id.slice('\0progression-event:'.length, -'.text'.length)
        return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`
      }
    },
  }],
  resolve: { alias: { 'cloudflare:workers': resolve(import.meta.dirname, 'src/cloudflare-shim.ts') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 15_000 },
})
