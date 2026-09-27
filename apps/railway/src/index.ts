import { serve } from '@hono/node-server'

import { SQLiteD1 } from './d1-adapter'
import { buildEnvironment } from './env'
import { migrate } from './migrate'
import { createRouter, resolveService } from './router'

const port = Number(process.env.PORT || 8080)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port')
const db = new SQLiteD1(process.env.DATABASE_PATH || './data/recflare.sqlite')
console.info(`Applied ${migrate(db)} database migrations`)
const runtime = buildEnvironment(db)
const fetch = createRouter(runtime, () => db.ping())
const server = serve({ fetch, port, hostname: '0.0.0.0' }, info => console.info(`Railway server listening on 0.0.0.0:${info.port}`))

server.on('upgrade', (request, socket, head) => {
  const host = request.headers.host || 'localhost'
  const url = new URL(request.url || '/', `http://${host}`)
  const resolved = resolveService(new Request(url), runtime.base.DOMAIN, runtime.base.SUBDOMAINS)
  if (!resolved || resolved.name !== 'notify' || new URL(resolved.request.url).pathname !== '/hub/v1') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return
  }
  void runtime.hub.upgrade(request, socket, head, process.env.JWT_SECRET!, url).catch(error => {
    console.error('WebSocket upgrade failed:', error)
    socket.destroy()
  })
})

const stop = () => {
  server.close()
  runtime.hub.websocketServer.close()
  void runtime.redis.close()
  runtime.hub.db.close()
  db.close()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
