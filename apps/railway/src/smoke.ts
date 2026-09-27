import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(ok => server.listen(0, '0.0.0.0', ok))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(ok => server.close(() => ok()))
  return port
}

const directory = await mkdtemp(join(tmpdir(), 'recflare-railway-'))
const port = await freePort()
const child = spawn(process.execPath, [resolve(import.meta.dirname, 'index.js')], {
  env: { ...process.env, JWT_SECRET: 'smoke-test-secret', DOMAIN: 'example.test', DATABASE_PATH: join(directory, 'recflare.sqlite'), PORT: String(port) },
  stdio: 'inherit',
})
try {
  let response: Response | undefined
  for (let attempt = 0; attempt < 40; attempt++) {
    try { response = await fetch(`http://127.0.0.1:${port}/health`); break } catch { await new Promise(ok => setTimeout(ok, 250)) }
  }
  if (!response?.ok) throw new Error(`Health failed: ${response?.status}`)
  const route = (host: string, path = '/') => new Promise<{ status: number; body: string }>((ok, fail) => {
    httpRequest({ hostname: '127.0.0.1', port, path, headers: { host } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => ok({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    }).on('error', fail).end()
  })
  const ns = await route('example.test')
  if (ns.status !== 200 || !(JSON.parse(ns.body) as Record<string, string>).Auth?.includes('auth.example.test')) throw new Error('Name server failed')
  const cdn = await route('cdn.example.test')
  if (cdn.status !== 200 || (JSON.parse(cdn.body) as { service: string }).service !== 'cdn') throw new Error('Hostname routing failed')
  const config = await route('api.example.test', '/api/config/v2')
  if (config.status !== 200 || !(JSON.parse(config.body) as { ShareBaseUrl: string }).ShareBaseUrl.includes('www.example.test')) throw new Error('API config failed')
  const version = await route('api.example.test', '/api/versioncheck/v4?v=20250718.01')
  if (version.status !== 200 || (JSON.parse(version.body) as { VersionStatus: number }).VersionStatus !== 0) throw new Error('20250718.01 version check failed')
  for (const service of ['auth', 'rooms', 'match']) {
    const response = await route(`${service}.example.test`, service === 'rooms' ? '/' : '/openapi.json')
    if (response.status !== 200) throw new Error(`${service} service failed: ${response.status}`)
  }
  console.info('Railway smoke test passed')
} finally {
  child.kill('SIGTERM')
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
