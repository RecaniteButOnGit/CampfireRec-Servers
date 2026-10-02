import accounts from '../../accounts/src/accounts.app'
import ai from '../../ai/src/ai.app'
import api from '../../api/src/api.app'
import auth from '../../auth/src/auth.app'
import cards from '../../cards/src/cards.app'
import cdn from '../../cdn/src/cdn.app'
import chat from '../../chat/src/chat.app'
import clubs from '../../clubs/src/clubs.app'
import commerce from '../../commerce/src/commerce.app'
import datacollection from '../../datacollection/src/datacollection.app'
import { app as discovery } from '../../discovery/src/discovery.app'
import { app as econ } from '../../econ/src/econ.app'
import img from '../../img/src/img.app'
import leaderboard from '../../leaderboard/src/leaderboard.app'
import link from '../../link/src/link.app'
import lists from '../../lists/src/lists.app'
import { app as match } from '../../match/src/match.app'
import moderation from '../../moderation/src/moderation.app'
import notify from '../../notify/src/notify.app'
import ns from '../../ns/src/ns.app'
import platformnotifications from '../../platformnotifications/src/platformnotifications.app'
import playersettings from '../../playersettings/src/playersettings.app'
import roomcomments from '../../roomcomments/src/roomcomments.app'
import { app as rooms } from '../../rooms/src/rooms.app'
import storage from '../../storage/src/storage.app'
import { app as www } from '../../www/src/www.app'

import { NodeExecutionContext } from './execution-context'
import type { RailwayEnvironment } from './env'

const services = { accounts, ai, api, auth, cards, cdn, chat, clubs, commerce, datacollection,
  discovery, econ, img, leaderboard, link, lists, match, moderation, notify, ns,
  platformnotifications, playersettings, roomcomments, rooms, storage, www } as const
type ServiceName = keyof typeof services

function overrides(raw: string): Record<string, string> {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}

export function resolveService(request: Request, domain: string, subdomains: string): { name: ServiceName; request: Request } | undefined {
  const url = new URL(request.url)
  const hostname = url.hostname.toLowerCase()
  const configured = domain.toLowerCase()
  if (hostname === configured) return { name: 'ns', request }
  if (hostname.endsWith(`.${configured}`)) {
    const label = hostname.slice(0, -(configured.length + 1)).split('.')[0]
    const alias = Object.entries(overrides(subdomains)).find(([service, host]) => host === label && !(label in services) && service in services)?.[0]
    const name = (alias ?? label) as ServiceName
    return name in services ? { name, request } : undefined
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    const [, first, ...rest] = url.pathname.split('/')
    if (first && first in services) {
      url.pathname = `/${rest.join('/')}`
      return { name: first as ServiceName, request: new Request(url, request) }
    }
    if (url.pathname === '/') return { name: 'ns', request }
  }
  return undefined
}

export function createRouter(runtime: RailwayEnvironment, databasePing: () => boolean) {
  runtime.base.AUTH = { fetch: (request: Request) => Promise.resolve(auth.fetch(request, runtime.base as never, new NodeExecutionContext() as never)) }
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      const database = databasePing()
      const [redis, cdn, img] = await Promise.all([runtime.redis.ping(), runtime.cdn?.ping() ?? false, runtime.img?.ping() ?? false])
      return Response.json({ ok: database, database, redis, cdn, img }, { status: database ? 200 : 503 })
    }
    const resolved = resolveService(request, runtime.base.DOMAIN, runtime.base.SUBDOMAINS)
    if (!resolved) return Response.json({ error: 'unknown_service' }, { status: 404 })
    if (resolved.name === 'discovery') {
      const pathname = new URL(resolved.request.url).pathname
      const prefix = '/sections/pagesource/'
      if (pathname.startsWith(prefix)) {
        const source = pathname.slice(prefix.length)
        let decodedSource = source
        try { decodedSource = decodeURIComponent(source) } catch { /* Keep the raw path. */ }
        const tokenIndex = decodedSource.indexOf('8254TOKEN')
        const label = decodedSource.startsWith('AIRequest') ? 'AIRequest'
			: decodedSource.startsWith('EscapeesImportProgress') ? 'EscapeesImportProgress'
			: decodedSource.startsWith('EscapeesImport') ? 'EscapeesImport'
			: tokenIndex === -1 ? source : decodedSource.slice(0, tokenIndex)
        console.info(`[discovery/pagesource] ${label}`)
      }
    }
    const app = services[resolved.name]
    const env = { ...runtime.base, NAME: resolved.name, ASSETS: runtime.assets[resolved.name] }
    return app.fetch(resolved.request, env as never, new NodeExecutionContext() as never)
  }
}
