import { WebSocketServer, type WebSocket } from 'ws'
import { validateAndGetAccountId } from '@repo/jwt'

import { NotificationsHub } from '../../notify/src/notifications-hub'
import { SQLiteD1 } from './d1-adapter'

type State = { connectionId: string; handshakeDone: boolean; playerId: number }

class SocketAdapter {
  private attachment: State | undefined
  constructor(readonly socket: WebSocket) {}
  serializeAttachment(state: State) { this.attachment = state }
  deserializeAttachment(): State | undefined { return this.attachment }
  send(data: string) { this.socket.send(data) }
  close(code?: number, reason?: string) { this.socket.close(code, reason) }
}

class HubContext {
  private sockets = new Map<string, SocketAdapter>()
  storage: { sql: { exec: <T = Record<string, unknown>>(query: string, ...params: unknown[]) => { toArray: () => T[] } } }

  constructor(db: SQLiteD1) {
    this.storage = { sql: { exec: <T>(query: string, ...params: unknown[]) => {
      if (params.length === 0 && query.includes(';')) { db.sqlite.exec(query); return { toArray: () => [] as T[] } }
      const statement = db.sqlite.prepare(query)
      const rows = statement.columns().length ? statement.all(...params as []) : (statement.run(...params as []), [])
      return { toArray: () => rows as T[] }
    } } }
  }

  blockConcurrencyWhile(fn: () => Promise<void> | void): Promise<void> { return Promise.resolve().then(fn) }
  getWebSockets(tag?: string): SocketAdapter[] { return tag ? [this.sockets.get(tag)].filter((s): s is SocketAdapter => !!s) : [...this.sockets.values()] }
  attach(id: string, socket: SocketAdapter) { this.sockets.set(id, socket) }
  detach(id: string) { this.sockets.delete(id) }
}

export class NodeNotificationsHub {
  readonly db: SQLiteD1
  readonly context: HubContext
  readonly hub: NotificationsHub
  readonly namespace: { getByName: (name: string) => NotificationsHub }
  readonly websocketServer = new WebSocketServer({ noServer: true })

  constructor(path: string, env: unknown) {
    this.db = new SQLiteD1(path)
    this.context = new HubContext(this.db)
    this.hub = new NotificationsHub(this.context as never, env as never)
    this.namespace = { getByName: (name) => {
      if (name !== 'global') throw new Error(`Unknown notifications hub: ${name}`)
      return this.hub
    } }
  }

  async upgrade(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, secret: string, url: URL) {
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    let playerId = await validateAndGetAccountId(new Request(url, { headers }), secret)
    if (playerId === null && url.searchParams.has('access_token')) {
      headers.set('authorization', `Bearer ${url.searchParams.get('access_token')}`)
      playerId = await validateAndGetAccountId(new Request(url, { headers }), secret)
    }
    if (playerId === null) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const connectionId = url.searchParams.get('id') || crypto.randomUUID()
    this.websocketServer.handleUpgrade(request, socket, head, ws => {
      const adapter = new SocketAdapter(ws)
      adapter.serializeAttachment({ connectionId, handshakeDone: false, playerId })
      this.context.attach(connectionId, adapter)
      this.db.sqlite.prepare('INSERT OR REPLACE INTO connection_owner (connectionId, playerId) VALUES (?, ?)').run(connectionId, playerId)
      ws.on('message', data => { void this.hub.webSocketMessage(adapter as never, data.toString()).catch(error => console.error('hub message failed:', error)) })
      ws.on('close', () => { this.context.detach(connectionId); void this.hub.webSocketClose(adapter as never).catch(error => console.error('hub close failed:', error)) })
      ws.on('error', error => console.error('hub socket error:', error))
    })
  }
}
