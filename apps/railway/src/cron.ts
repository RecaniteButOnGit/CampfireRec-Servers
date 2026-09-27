import { scheduled as econScheduled } from '../../econ/src/econ.app'
import { scheduled as matchScheduled } from '../../match/src/match.app'
import { scheduled as roomsScheduled } from '../../rooms/src/rooms.app'
import { scheduled as wwwScheduled } from '../../www/src/www.app'

import { SQLiteD1 } from './d1-adapter'
import { buildEnvironment } from './env'
import { NodeExecutionContext } from './execution-context'
import { migrate } from './migrate'

const scheduled = { match: matchScheduled, rooms: roomsScheduled, econ: econScheduled, www: wwwScheduled }
const job = process.argv[2] as keyof typeof scheduled
if (!(job in scheduled)) throw new Error('Usage: pnpm railway:cron <match|rooms|econ|www>')
const db = new SQLiteD1(process.env.DATABASE_PATH || './data/recflare.sqlite')
try {
  migrate(db)
  const runtime = buildEnvironment(db)
  const context = new NodeExecutionContext()
  await scheduled[job]({ scheduledTime: Date.now(), cron: '' } as never, { ...runtime.base, NAME: job, ASSETS: runtime.assets[job] } as never, context as never)
  await context.drain()
  await runtime.redis.close()
  runtime.hub.db.close()
} finally { db.close() }
