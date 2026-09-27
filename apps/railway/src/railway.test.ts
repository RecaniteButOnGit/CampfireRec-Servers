import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateToken } from '@repo/jwt'

import cdnApp from '../../cdn/src/cdn.app'
import { FileAssets } from './assets-adapter'
import { SQLiteD1 } from './d1-adapter'
import { buildEnvironment } from './env'
import { NodeExecutionContext } from './execution-context'
import { RedisKV } from './kv-adapter'
import { migrate } from './migrate'
import { NodeNotificationsHub } from './notifications-adapter'
import { S3Bucket } from './r2-adapter'
import { createRouter, resolveService } from './router'

const dirs: string[] = []
function temp() { const path = mkdtempSync(join(tmpdir(), 'railway-test-')); dirs.push(path); return path }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 10 }) })

describe('SQLite D1 adapter and migrations', () => {
  it('binds safely, returns first/all/raw, and reports writes', async () => {
    const db = new SQLiteD1(':memory:')
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
      const write = await db.prepare('INSERT INTO t (name) VALUES (?)').bind("x' OR 1=1 --").run()
      expect(write.meta.last_row_id).toBe(1)
      expect(await db.prepare('SELECT name FROM t WHERE id = ?').bind(1).first('name')).toBe("x' OR 1=1 --")
      expect((await db.prepare('SELECT * FROM t').all()).results).toHaveLength(1)
      expect(await db.prepare('SELECT id, name FROM t').raw()).toEqual([[1, "x' OR 1=1 --"]])
    } finally { db.close() }
  })

  it('batches transactionally and retains RETURNING rows', async () => {
    const db = new SQLiteD1(':memory:')
    try {
      await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT UNIQUE)')
      const [created] = await db.batch([db.prepare('INSERT INTO t (value) VALUES (?) RETURNING *').bind('a')])
      expect((created as { results: unknown[] }).results).toEqual([{ id: 1, value: 'a' }])
      await expect(db.batch([db.prepare('INSERT INTO t (value) VALUES (?)').bind('b'), db.prepare('INSERT INTO t (value) VALUES (?)').bind('a')])).rejects.toThrow()
      expect((await db.prepare('SELECT * FROM t').all()).results).toHaveLength(1)
    } finally { db.close() }
  })

  it('applies source migrations once and persists across reopen', async () => {
    const path = join(temp(), 'recflare.sqlite')
    const first = new SQLiteD1(path)
    expect(migrate(first)).toBe(97)
    const makerRoom2 = await first.prepare(
      "SELECT json_extract(data, '$.UnitySceneId') AS scene FROM subroom WHERE room_id = 46"
    ).first<{ scene: string }>()
    expect(makerRoom2?.scene).toBe('5d4e40d8-f289-4295-a6e1-4f907835007d')
    first.close()
    const second = new SQLiteD1(path)
    try { expect(migrate(second)).toBe(0); expect(second.ping()).toBe(true) } finally { second.close() }
  })
})

describe('Redis KV adapter', () => {
  it('namespaces get, put, delete, JSON and expiration', async () => {
    const values = new Map<string, string>()
    const client = { isOpen: true, get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { values.set(key, value) }),
      del: vi.fn(async (key: string) => { values.delete(key) }),
      ping: vi.fn(async () => 'PONG'), quit: vi.fn() }
    const kv = new RedisKV('redis://unused', 'player-settings')
    Object.assign(kv, { client })
    await kv.put('player:2', '{"a":1}', { expirationTtl: 5 })
    expect([...values.keys()]).toEqual(['recflare:player-settings:player:2'])
    expect(await kv.get('player:2', 'json')).toEqual({ a: 1 })
    await kv.delete('player:2')
    expect(await kv.get('player:2')).toBeNull()
    expect(await kv.ping()).toBe(true)
  })
})

function fakeBucket() {
  const bucket = new S3Bucket('test', { endpoint: 'http://localhost:9000', accessKeyId: 'x', secretAccessKey: 'y', region: 'auto' })
  const objects = new Map<string, Buffer>()
  const requests: string[] = []
  Object.assign(bucket.client, { send: async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer; Range?: string } }) => {
    requests.push(`${command.constructor.name}:${command.input.Range ?? ''}`)
    const { Key: key } = command.input
    if (command.constructor.name === 'PutObjectCommand') { objects.set(key, Buffer.from(command.input.Body!)); return {} }
    if (command.constructor.name === 'DeleteObjectCommand') { objects.delete(key); return {} }
    const data = objects.get(key)
    if (!data) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
    if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: data.length, ETag: '"abc"', ContentType: 'application/octet-stream' }
    const range = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '')
    const slice = range ? data.subarray(Number(range[1]), Number(range[2]) + 1) : data
    return { Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(slice); controller.close() } }) } }
  } })
  return { bucket, objects, requests }
}

describe('S3 R2 adapter and CDN', () => {
  it('puts, streams, heads and deletes an object', async () => {
    const { bucket } = fakeBucket()
    await bucket.put('room/x', new Uint8Array([1, 2, 3]))
    expect((await bucket.head('room/x'))?.size).toBe(3)
    expect(new Uint8Array(await (await bucket.get('room/x'))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    await bucket.delete('room/x')
    expect(await bucket.get('room/x')).toBeNull()
  })

  it('uses S3 range reads and returns CDN 206 with exact headers', async () => {
    const { bucket, requests } = fakeBucket()
    await bucket.put('room/x', Buffer.from('abcdefghij'))
    const response = await cdnApp.fetch(new Request('https://cdn.example.test/room/x', { headers: { range: 'bytes=2-5' } }),
      { CDN_ASSETS: bucket, NAME: 'cdn', ENVIRONMENT: 'test', SENTRY_RELEASE: 'test' } as never,
      new NodeExecutionContext() as never)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('cdef')
    expect(requests).toContain('GetObjectCommand:bytes=2-5')
    const unsatisfiable = await cdnApp.fetch(new Request('https://cdn.example.test/room/x', { headers: { range: 'bytes=1000-1999' } }),
      { CDN_ASSETS: bucket, NAME: 'cdn', ENVIRONMENT: 'test', SENTRY_RELEASE: 'test' } as never,
      new NodeExecutionContext() as never)
    expect(unsatisfiable.status).toBe(206)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes 0-9/10')
  })
})

describe('routing, health and compatibility', () => {
  it('routes a production hostname without changing the path', () => {
    const request = new Request('https://rooms.example.test/api/rooms')
    const result = resolveService(request, 'example.test', '{}')!
    expect(result.name).toBe('rooms')
    expect(new URL(result.request.url).pathname).toBe('/api/rooms')
  })

  it('routes local prefixes and honors configured aliases', () => {
    expect(new URL(resolveService(new Request('http://localhost:8080/auth/connect/token'), 'example.test', '{}')!.request.url).pathname).toBe('/connect/token')
    expect(resolveService(new Request('https://settings.example.test/'), 'example.test', '{"playersettings":"settings"}')?.name).toBe('playersettings')
  })

  it('boots without optional integrations and answers health', async () => {
    const prior = { ...process.env }
    process.env.JWT_SECRET = 'test-secret'
    process.env.DOMAIN = 'example.test'
    delete process.env.REDIS_URL
    const db = new SQLiteD1(join(temp(), 'db.sqlite'))
    try {
      const runtime = buildEnvironment(db)
      const route = createRouter(runtime, () => db.ping())
      const response = await route(new Request('https://example.test/health'))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, database: true, redis: false, cdn: false, img: false })
      const discovery = await route(new Request('https://example.test/'))
      expect((await discovery.json() as Record<string, string>).Auth).toBe('https://auth.example.test')
      runtime.hub.db.close()
    } finally { db.close(); process.env = prior }
  })

  it('serves only files inside the designated static directory', async () => {
    const assets = new FileAssets(join(import.meta.dirname, '../../cdn/static'))
    expect((await assets.fetch('https://cdn.example.test/config/LoadingScreenTipData')).status).toBe(404)
    expect((await assets.fetch('https://cdn.example.test/config/%2e%2e/%2e%2e/wrangler.jsonc')).status).toBe(404)
  })
})

describe('notification hub and execution context', () => {
  it('queues offline notifications and clears pending state', async () => {
    const hub = new NodeNotificationsHub(join(temp(), 'hub.sqlite'), {})
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(await hub.hub.notifyPlayer(2, 'AccountUpdate', { value: 1 })).toEqual({ delivered: 0, queued: true })
      const state = await hub.hub.inspect()
      expect(state.pending[0].playerId).toBe(2)
      expect(await hub.hub.clearPending(2)).toEqual({ cleared: 1 })
    } finally { hub.db.close() }
  })

  it('logs rejected waitUntil work and drains it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const context = new NodeExecutionContext()
    context.waitUntil(Promise.reject(new Error('failed job')))
    await expect(context.drain()).rejects.toThrow('waitUntil tasks failed')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('keeps an authenticated SignalR WebSocket and delivers the original frame format', async () => {
    const hub = new NodeNotificationsHub(join(temp(), 'websocket.sqlite'), {})
    await new Promise(resolve => setImmediate(resolve))
    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      void hub.upgrade(request, socket, head, 'test-secret', new URL(request.url!, `http://${request.headers.host}`))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const token = await generateToken('2', 'platform-2', 0, 'test-secret')
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hub/v1?id=client-2&access_token=${token}`)
    const messages: string[] = []
    socket.on('message', frame => messages.push(frame.toString()))
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      socket.send('{"protocol":"json","version":1}\x1e')
      for (let i = 0; messages.length < 2 && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(messages[0]).toBe('{}\x1e')
      expect(messages[1]).toContain('"target":"OnConnect"')
      expect(await hub.hub.notifyPlayer(2, 'AccountUpdate', { foo: 1 })).toEqual({ delivered: 1, queued: false })
      for (let i = 0; messages.length < 3 && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(messages[2]).toContain('"target":"Notification"')
      expect(messages[2]).toContain('\\"Id\\":\\"AccountUpdate\\"')
    } finally {
      socket.close()
      await new Promise(resolve => socket.once('close', resolve))
      await new Promise<void>(resolve => server.close(() => resolve()))
      hub.websocketServer.close()
      hub.db.close()
    }
  })
})
