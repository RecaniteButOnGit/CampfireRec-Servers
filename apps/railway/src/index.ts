import { serve } from '@hono/node-server'

import { SQLiteD1 } from './d1-adapter'
import { buildEnvironment } from './env'
import { migrate } from './migrate'
import { createRouter, resolveService } from './router'
import { startScheduler } from './scheduled'

const port = Number(process.env.PORT || 8080)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port')
const db = new SQLiteD1(process.env.DATABASE_PATH || './data/recflare.sqlite')
console.info(`Applied ${migrate(db)} database migrations`)
// One-time operator-requested credential recovery; the supplied value is a salted hash.
const recoveryHash = process.env.RECIRCUIT_ONCE_RECANITE_HASH
if (recoveryHash) {
  if (!/^[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{43}=$/.test(recoveryHash)) throw new Error('Invalid recovery hash format')
  db.sqlite.exec('BEGIN IMMEDIATE')
  try {
    db.sqlite.exec('CREATE TABLE IF NOT EXISTS recircuit_operator_jobs (name TEXT PRIMARY KEY)')
    const job = db.sqlite.prepare('INSERT OR IGNORE INTO recircuit_operator_jobs (name) VALUES (?)').run('recanite-credential-recovery-20261029')
    if (job.changes === 1) {
      const updated = db.sqlite.prepare("UPDATE account SET data = json_set(data, '$.passwordHash', ?) WHERE account_id = 2 AND username_lower = ?").run(recoveryHash, 'recanite')
      if (updated.changes !== 1) throw new Error('Recovery account did not match')
      console.info('Completed one-time Recanite credential recovery')
    }
    db.sqlite.exec('COMMIT')
  } catch (error) { db.sqlite.exec('ROLLBACK'); throw error }
}

const runtime = buildEnvironment(db)
const fetch = createRouter(runtime, () => db.ping())
const server = serve({ fetch, port, hostname: '0.0.0.0' }, info => console.info(`Railway server listening on 0.0.0.0:${info.port}`))
const scheduler = startScheduler(runtime)

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
  clearInterval(scheduler)
  server.close()
  runtime.hub.websocketServer.close()
  void runtime.redis.close()
  runtime.hub.db.close()
  db.close()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
