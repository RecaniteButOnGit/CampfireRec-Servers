import { build } from 'esbuild'
import { resolve } from 'node:path'

const shim = resolve('src/cloudflare-shim.ts')
const options = {
  bundle: true, platform: 'node', target: 'node24', format: 'esm', outdir: 'dist', sourcemap: true,
  banner: { js: "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);" },
  packages: 'bundle', external: ['@aws-sdk/client-s3', '@hono/node-server', 'redis', 'ws', '@cf-wasm/photon'],
  plugins: [{ name: 'node-cloudflare-shim', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: shim }))
  } }],
}
await build({ ...options, entryPoints: ['src/index.ts', 'src/migrate.ts', 'src/cron.ts', 'src/smoke.ts'] })
