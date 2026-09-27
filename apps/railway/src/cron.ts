import { SQLiteD1 } from './d1-adapter'
import { buildEnvironment } from './env'
import { migrate } from './migrate'
import { jobs, runScheduled, type Job } from './scheduled'

const job = process.argv[2] as Job
if (!(job in jobs)) throw new Error('Usage: pnpm railway:cron <match|rooms|econ|www>')
const db = new SQLiteD1(process.env.DATABASE_PATH || './data/recflare.sqlite')
try {
  migrate(db)
  const runtime = buildEnvironment(db)
  await runScheduled(job, runtime)
  await runtime.redis.close()
  runtime.hub.db.close()
} finally { db.close() }
