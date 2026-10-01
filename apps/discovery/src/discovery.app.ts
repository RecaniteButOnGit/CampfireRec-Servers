import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'

import { authorizedToken, handleAIRequest, parseTokenSuffix } from './ai-request'
import {
	DiscoverySections,
	json,
	PAGE_SOURCE_PARAM,
	SECTION_IDS_PARAM,
	ServiceStatus,
} from './openapi'
import { fetchPageSource, readSections, SECTIONS_CATALOGUE } from './page-sources'

import type { App } from './context'

/**
 * Discovery Worker. Serves the layout of the client's discovery pages — which carousels a
 * page shows and in what order — out of `static/`, one file per page source, through the
 * ASSETS binding (see `page-sources.ts`), plus `sections.json`, the id-keyed catalogue the
 * bulk lookup filters. It does not serve the carousels' CONTENTS: each section names a
 * client-side feed the client resolves against the `rooms`/`api` workers itself.
 *
 * Published layouts are unauthenticated. The CV2 Ping and AIRequest probes require RRTOKEN.
 */
const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	// Root health check.
	.get(
		'/',
		describeRoute({
			tags: ['Service'],
			summary: 'Health check',
			description: 'Liveness probe for the discovery worker. No auth.',
			responses: { 200: json(ServiceStatus, 'Service is up') },
		}),
		(c) => c.json({ service: 'discovery', status: 'ok' })
	)

	// A set of sections looked up by id, out of the catalogue in `static/sections.json`.
	//
	// This is the id-keyed counterpart to the page-source route: a page source hands back a
	// whole page's rows in draw order, while this hands back exactly the rows asked for,
	// which is how the client refreshes sections it already knows the ids of without
	// re-fetching every page they came from.
	//
	// The reference reads its catalogue file and filters it, so the failure modes are the
	// file's, not the query's: an id matching nothing is simply absent from the answer
	// rather than an error, and a query naming NO ids answers `[]` rather than the whole
	// catalogue — the client asks for nothing when it wants nothing. Only a missing
	// catalogue file is a 404.
	.get(
		'/sections/bulk',
		describeRoute({
			tags: ['Discovery', '2025'],
			summary: 'Look up sections by id',
			description: [
				'The sections named by the repeated `?id=` query, drawn from the catalogue in',
				'`static/sections.json` — the union of the rows the page sources are built from.',
				'',
				'The answer is that file FILTERED, which fixes the edges: rows come back in the',
				'catalogue’s order rather than the query’s, an id that matches nothing is left out',
				'instead of erroring, and repeating an id still yields it once. A query with no `id`',
				'at all answers `[]`. Rows are served exactly as stored, so a field this service',
				'doesn’t model survives the round trip.',
				'',
				'Same section shape as `/sections/pagesource/{type}`: a section NAMES a feed',
				'(`source`/`sourceMetadata`) that the client resolves itself. Nothing here is',
				'player-specific, so there is no auth.',
			].join('\n'),
			parameters: [SECTION_IDS_PARAM],
			responses: {
				200: json(DiscoverySections, 'The requested sections, in catalogue order'),
				404: { description: 'The catalogue file is not published' },
			},
		}),
		async (c) => {
			// `queries` and not `query`: the ids arrive as a repeated parameter, and `query`
			// would collapse them to the first one and silently drop the rest of the page.
			const ids = c.req.queries('id')
			if (ids === undefined || ids.length === 0) return c.json([])

			const sections = await readSections(c, SECTIONS_CATALOGUE)
			if (sections === null) return c.notFound()

			const wanted = new Set(ids)
			return c.json(sections.filter((s) => typeof s.id === 'string' && wanted.has(s.id)))
		}
	)

	// One discovery page's section layout, served verbatim from `static/<type>.json`.
	// `Ping` and `AIRequest[...]` use the same section-list response shape for CV2.
	.get(
		'/sections/pagesource/:type',
		describeRoute({
			tags: ['Discovery', '2025'],
			summary: 'Section layout for a page source',
			description: [
				'The sections of one discovery page, in the order the client draws them. Except for',
				'`Ping` and `AIRequest[...]`, `{type}` is the filename — the body is',
				'`static/<type>.json` served verbatim —',
				'so the page sources',
				'that exist are whichever files are published (`WatchHome`, `PlayHighlight`,',
				'`CommunityBoard`, `PlayMenuTabs`, `PlayCategories`, `StoreCategories`,',
				'`StoreFeatured`, `StoreClothing`, `StoreConsumables` and `bulk` at the time of',
				'writing). The match is exact, case included.',
				'',
				'This replaces the `Discovery.DiscoveryPageContent.*` game configs, which carried the',
				'same layouts as embedded JSON strings: with `Discovery.UseNewDiscoveryServerAPI` set',
				'to `True` the client asks this service instead. The two are not the same shape — the',
				'configs wrapped the list in `{ pageSource, sections }` with PascalCase fields, while',
				'this answers the bare ARRAY with camelCase ones.',
				'',
				'`Ping8254TOKEN"..."` returns one section with `id` and `sourceMetadata` set to',
				'`Pong` when the trailing token matches `RRTOKEN`.',
				'`AIRequest[Prompt:"...",Model:"gpt-6-luna",SystemPrompt:"...",Reasoning:"none"]8254TOKEN"..."`',
				'returns the model text in those same two fields when `OPENAIKEY` is configured and',
				'the trailing token matches `RRTOKEN`.',
				'',
				'Published layout sections only NAME feeds (`source`/`sourceMetadata`); their rooms,',
				'items and accounts are fetched separately by the client. Those layouts are public;',
				'the two CV2 probes require the shared token.',
			].join('\n'),
			parameters: [PAGE_SOURCE_PARAM],
			responses: {
				200: json(DiscoverySections, 'The page’s sections'),
				304: { description: '`If-None-Match` matched the file’s etag (no body)' },
				401: { description: '`Ping` or `AIRequest` token missing or incorrect' },
				404: { description: 'No file is published under that name' },
			},
		}),
		async (c) => {
			const type = c.req.param('type')
			if (type === 'Ping' || type.startsWith('Ping8254TOKEN')) {
				c.header('Cache-Control', 'no-store')
				if (!(await authorizedToken(parseTokenSuffix(type.slice('Ping'.length)), c.env))) {
					return c.body(null, 401)
				}
				return c.json([{
					id: 'Pong',
					sectionType: 13,
					sectionSubType: 'Pong',
					source: 'PageSource',
					sourceMetadata: 'Pong',
					displayMetadata: JSON.stringify({ DisplayTitle: 'Pong' }),
				}])
			}
			if (type.startsWith('AIRequest')) {
				c.header('Cache-Control', 'no-store')
				// A raw '?' inside a CV2 prompt moves the rest of the page source name into
				// the URL query, including the token suffix. Rejoin it before parsing.
				const query = new URL(c.req.url).search
				const queryText = query && !type.includes(']8254TOKEN')
					? new URLSearchParams(`value=${query.slice(1).replaceAll('&', '%26').replaceAll('+', '%2B')}`).get('value')
					: null
				const sections = await handleAIRequest(queryText === null ? type : `${type}?${queryText}`, c.env)
				return sections ? c.json(sections) : c.body(null, 401)
			}
			const res = await fetchPageSource(c, type)
			return res ?? c.notFound()
		}
	)

// The generated spec. Documentation only — no request is validated against it (see
// openapi.ts). `hide: true` keeps this route out of its own output.
app.get(
	'/openapi.json',
	describeRoute({ hide: true }),
	withCleanSpec(
		openAPIRouteHandler(app, {
			documentation: {
				info: {
					title: 'recflare discovery',
					version: '1.0.0',
					description: [
						'Discovery page layouts for recflare, a private-server reimplementation of the Rec',
						'Room backend. The client asks this service which sections each of its discovery',
						'pages shows — Watch home, the play menu and its tabs, the community board, the store',
						'pages — and draws them in the order given.',
						'',
						'Each layout is a file in `static/`, published as a Workers static asset and served',
						'verbatim by filename, so the set of page sources is whatever is published rather',
						'than anything the code enumerates. Nothing is editable at runtime and every client',
						'gets the same answer, so the routes are unauthenticated.',
						'',
						'Sections can also be fetched by id rather than by page: `/sections/bulk` filters',
						'`static/sections.json`, the catalogue those layouts draw their rows from.',
						'',
						'A section names a feed rather than carrying its contents: the client resolves the',
						'rooms, items and accounts behind each carousel against the `rooms` and `api` workers',
						'itself.',
					].join('\n'),
				},
				servers: [{ url: 'https://discovery.recflare.net', description: 'Production' }],
			},
		})
	)
)

export default app
