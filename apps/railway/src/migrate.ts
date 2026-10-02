import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { SQLiteD1 } from './d1-adapter'

const MIGRATION_SERVICES = ['auth', 'api', 'rooms', 'match', 'clubs', 'chat', 'econ', 'img', 'lists', 'leaderboard', 'roomcomments', 'discovery'] as const
const repo = resolve(import.meta.dirname, '../../..')

export function migrate(db: SQLiteD1): number {
  let applied = 0
  for (const service of MIGRATION_SERVICES) {
    const directory = resolve(repo, 'apps', service, 'migrations')
    const config = readFileSync(resolve(repo, 'apps', service, 'wrangler.jsonc'), 'utf8')
    const table = /"migrations_table"\s*:\s*"([a-zA-Z0-9_]+)"/.exec(config)?.[1] ?? 'd1_migrations'
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.sql')).sort()) {
      db.sqlite.exec('BEGIN IMMEDIATE')
      try {
        const already = db.sqlite.prepare(`SELECT 1 FROM "${table}" WHERE name = ?`).get(name)
        if (!already) {
          db.sqlite.exec(readFileSync(resolve(directory, name), 'utf8'))
          db.sqlite.prepare(`INSERT INTO "${table}" (name) VALUES (?)`).run(name)
          applied++
        }
        db.sqlite.exec('COMMIT')
      } catch (error) {
        db.sqlite.exec('ROLLBACK')
        throw new Error(`Migration ${service}/${name} failed`, { cause: error })
      }
    }
  }
  return applied
}

if (process.argv[1] && /migrate\.(?:js|ts)$/.test(process.argv[1])) {
  const db = new SQLiteD1(process.env.DATABASE_PATH || './data/recflare.sqlite')
  try { console.info(`Applied ${migrate(db)} migrations`) } finally { db.close() }
}
