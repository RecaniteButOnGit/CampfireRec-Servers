import { scheduled as econScheduled } from '../../econ/src/econ.app'
import { scheduled as matchScheduled } from '../../match/src/match.app'
import { scheduled as roomsScheduled } from '../../rooms/src/rooms.app'
import { scheduled as wwwScheduled } from '../../www/src/www.app'

import { NodeExecutionContext } from './execution-context'
import type { RailwayEnvironment } from './env'

export const jobs = { match: matchScheduled, rooms: roomsScheduled, econ: econScheduled, www: wwwScheduled }
export type Job = keyof typeof jobs

export async function runScheduled(job: Job, runtime: RailwayEnvironment): Promise<void> {
  const context = new NodeExecutionContext()
  await jobs[job]({ scheduledTime: Date.now(), cron: '' } as never,
    { ...runtime.base, NAME: job, ASSETS: runtime.assets[job] } as never, context as never)
  await context.drain()
}

export function startScheduler(runtime: RailwayEnvironment): NodeJS.Timeout {
  const last = new Map<Job, string>()
  const tick = () => {
    const now = new Date()
    const minute = now.toISOString().slice(0, 16)
    const due: Job[] = []
    if (now.getUTCMinutes() % 5 === 0) due.push('match', 'rooms')
    if (now.getUTCDay() === 1 && now.getUTCHours() === 5 && now.getUTCMinutes() === 0) due.push('econ')
    if (now.getUTCHours() === 4 && now.getUTCMinutes() === 30) due.push('www')
    for (const job of due) {
      if (last.get(job) === minute) continue
      last.set(job, minute)
      void runScheduled(job, runtime).catch(error => console.error(`Scheduled ${job} failed:`, error))
    }
  }
  tick()
  return setInterval(tick, 20_000)
}
