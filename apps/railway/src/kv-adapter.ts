import { createClient, type RedisClientType } from 'redis'

export class RedisKV {
  private client: RedisClientType | undefined
  constructor(readonly url: string | undefined, readonly namespace: string) {}

  private async ready(): Promise<RedisClientType> {
    if (!this.url) throw new Error('REDIS_URL is not configured')
    if (!this.client) {
      this.client = createClient({ url: this.url, socket: { connectTimeout: 1500, reconnectStrategy: false } })
      this.client.on('error', error => console.error('Redis error:', error))
    }
    if (!this.client.isOpen) await this.client.connect()
    return this.client
  }

  private key(key: string) { return `recflare:${this.namespace}:${key}` }

  async get<T = string>(key: string, type: 'text' | 'json' | 'arrayBuffer' | { type?: string } = 'text'): Promise<T | null> {
    const client = await this.ready()
    const text = await client.get(this.key(key))
    if (text === null) return null
    const selected = typeof type === 'string' ? type : type.type ?? 'text'
    return (selected === 'json' ? JSON.parse(text) : selected === 'arrayBuffer' ? new TextEncoder().encode(text).buffer : text) as T
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options: { expiration?: number; expirationTtl?: number } = {}) {
    const client = await this.ready()
    const text = typeof value === 'string' ? value : value instanceof ArrayBuffer
      ? Buffer.from(value).toString() : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString()
    const expiry = options.expirationTtl ?? (options.expiration ? options.expiration - Math.floor(Date.now() / 1000) : undefined)
    if (expiry !== undefined && expiry <= 0) { await client.del(this.key(key)); return }
    await client.set(this.key(key), text, expiry === undefined ? undefined : { EX: expiry })
  }

  async delete(key: string) { await (await this.ready()).del(this.key(key)) }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const client = await this.ready()
    const prefix = this.key(options.prefix ?? '')
    const result = await client.scan(options.cursor ?? '0', { MATCH: `${prefix}*`, COUNT: options.limit ?? 1000 })
    return { keys: result.keys.map(name => ({ name: name.slice(this.key('').length) })), list_complete: result.cursor === '0',
      cursor: result.cursor === '0' ? undefined : result.cursor }
  }

  async ping(): Promise<boolean> { try { return (await (await this.ready()).ping()) === 'PONG' } catch { return false } }
  async close(): Promise<void> { if (this.client?.isOpen) await this.client.quit() }
}
