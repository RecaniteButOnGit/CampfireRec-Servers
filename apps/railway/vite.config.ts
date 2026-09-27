import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = resolve(import.meta.dirname, '../www')
function scalarStandalone(): Plugin {
  const require = createRequire(import.meta.url)
  return { name: 'scalar-standalone', async generateBundle() {
    const entry = require.resolve('@scalar/api-reference', { paths: [root] })
    this.emitFile({ type: 'asset', fileName: 'docs/scalar.standalone.js', source: await readFile(resolve(dirname(entry), 'browser/standalone.js')) })
  } }
}
export default defineConfig({ root, plugins: [react(), scalarStandalone()], build: { outDir: resolve(root, 'dist/client'), emptyOutDir: true } })
