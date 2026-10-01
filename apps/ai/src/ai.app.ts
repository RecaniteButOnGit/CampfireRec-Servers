import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler } from 'hono-openapi'
import { useWorkersLogger } from 'workers-tagged-logger'

import { getRoomById } from '@repo/domain'
import { withCleanSpec, withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import {
	AUTHED,
	boolQuery,
	GameAiAccessDenied,
	GameAiAccessGranted,
	GameAiSpendSummaryDenied,
	GameAiSpendSummaryGranted,
	HealthResponse,
	idParam,
	intQuery,
	json,
	jsonBody,
	MakerAiAccessResponse,
	MakerAiBalances,
	RealtimeSessionCreateBody,
	RealtimeSessionCreateResponse,
	RoomieAiAccess,
	RoomieUserFacts,
	UNAUTHORIZED_RESPONSE,
} from './openapi'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * AI Worker. Serves the access checks and budget reads the client makes before offering
 * its AI features. Roomie session creation also mints short-lived OpenAI credentials:
 *
 * - Game AI room reads are granted for two named test rooms. Model execution is not
 *   implemented here.
 * - Roomie runs on the CLIENT. Budget reads are granted in full and session creation
 *   hands it an ephemeral credential when the server has an OpenAI key.
 * - Maker AI meters model usage in dollars. Nothing here bills, so every figure is zero.
 */

/**
 * `int.MaxValue` — the client's energy fields are signed 32-bit ints, so this is the
 * largest budget it can hold. Anything larger (an int64 max, say) overflows on the way in
 * and lands as a negative number, i.e. no energy at all.
 */
const INT32_MAX = 2_147_483_647
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1-mini'
const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets'
const OPENAI_TIMEOUT_MS = 10_000

/**
 * The denial returned for rooms outside the Game AI allowlist.
 */
const GAME_AI_UNSUPPORTED = {
	success: false,
	error_id: 'AI.RoomDoesNotSupportGameAI',
	error: 'This room does not support Rec Room Game AI',
} as const

const GAME_AI_GRANTED = { success: true, error_id: null, error: null } as const

/** Resolve the canonical room Name through the shared room domain helper. */
async function roomSupportsGameAi(db: D1Database, rawRoomId: string | undefined) {
	const roomId = rawRoomId && /^\d+$/.test(rawRoomId) ? Number(rawRoomId) : null
	if (roomId === null || !Number.isSafeInteger(roomId) || roomId <= 0) {
		return { roomId: null, roomName: null, allowed: false }
	}

	const room = await getRoomById(db, roomId)
	const roomName = typeof room?.Name === 'string' ? room.Name : null
	return {
		roomId,
		roomName,
		allowed: roomName === 'GameAI' || roomName === 'GameAIRooms2',
	}
}

/**
 * Resolve the account id from a Bearer token (the route is auth-gated).
 * Returns `null` when the header is missing, the token is invalid, or the `sub` claim
 * isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

function realtimeFailure(c: Context<App>, error: string) {
	return c.json({ success: false, error, error_id: '', value: null })
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function safeDiagnostic(value: unknown, pattern: RegExp): string | undefined {
	return typeof value === 'string' && pattern.test(value) && !/(?:sk|ek)[-_]/.test(value)
		? value
		: undefined
}

async function safetyIdentifier(accountId: number): Promise<string> {
	const data = new TextEncoder().encode(`campfirerec-roomie:${accountId}`)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

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
			description: 'Liveness probe for the ai worker. No auth.',
			responses: { 200: json(HealthResponse, 'Service is up') },
		}),
		(c) => c.json({ service: 'ai', status: 'ok' })
	)

	// Whether the caller may use Game AI in one of the two named test rooms.
	.get(
		'/gameai/user/access',
		describeRoute({
			tags: ['Game AI', '2025'],
			summary: 'May the caller use Game AI here?',
			description:
				'Grants access only when the requested room’s canonical Name is exactly GameAI or ' +
				'GameAIRooms2. Other, missing, or malformed room ids get a 200 denial body. ' +
				'The bearer token is validated before room lookup.',
			security: AUTHED,
			parameters: [intQuery('roomId', 'The room the client is asking about.')],
			responses: {
				200: json(
					GameAiAccessGranted.or(GameAiAccessDenied),
					'Access granted for the two named rooms, denied elsewhere'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const check = await roomSupportsGameAi(c.env.DB, c.req.query('roomId'))
			console.info('Game AI access check', { accountId: id, ...check })
			return c.json(check.allowed ? GAME_AI_GRANTED : GAME_AI_UNSUPPORTED)
		}
	)

	// What an eligible room has spent on Game AI. Usage is currently unmetered.
	.get(
		'/gameai/room/:roomId{[0-9]+}/spendsummary',
		describeRoute({
			tags: ['Game AI', '2025'],
			summary: 'A room’s Game AI spend summary',
			description:
				'Returns an empty unmetered summary for GameAI and GameAIRooms2. Other rooms get ' +
				'the existing 200 denial with `value: null`.',
			security: AUTHED,
			parameters: [idParam('roomId', 'The room being asked about.')],
			responses: {
				200: json(
					GameAiSpendSummaryGranted.or(GameAiSpendSummaryDenied),
					'Empty unmetered summary for an eligible room, denial elsewhere'
				),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const check = await roomSupportsGameAi(c.env.DB, c.req.param('roomId'))
			return c.json(
				check.allowed ? { ...GAME_AI_GRANTED, value: {} } : { ...GAME_AI_UNSUPPORTED, value: null }
			)
		}
	)

	// Roomie AI's energy budget. Granted, unlike Game AI above: Roomie runs on the client
	// and only asks this service how much energy it has, so the honest answer for a server
	// that meters nothing is "as much as you can count".
	.get(
		'/roomieai/user/access',
		describeRoute({
			tags: ['Roomie AI', '2025'],
			summary: 'The caller’s Roomie AI energy budget',
			description: [
				'What Roomie may spend: an energy ceiling, what is left of it, and when it next',
				'refills. Nothing here meters energy, so the budget is `int.MaxValue` and never',
				'depletes — which is why `NextSubscriptionEnergyRechargeAt` is null, there being no',
				'spend to recharge from.',
				'',
				'The envelope is `{ success, error_id, error, value }`, NOT the flat body the Game AI',
				'check answers with. The two are different shapes on purpose — don’t unify them.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieAiAccess, 'The energy budget — always granted, always full'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({
				success: true,
				error_id: null,
				error: null,
				value: {
					MaxEnergyFromSubscriptions: INT32_MAX,
					EnergyLeft: INT32_MAX,
					NextSubscriptionEnergyRechargeAt: null,
					OutputAudioEnabled: true,
				},
			})
		}
	)

	// What Roomie has been told about the caller. Nothing observes players here, so it has
	// been told nothing.
	.get(
		'/roomieai/user/facts',
		describeRoute({
			tags: ['Roomie AI', '2025'],
			summary: 'What Roomie knows about the caller',
			description: [
				'The memory Roomie is primed with: `UserContext`, a prose profile written from past',
				'conversations, and `UserFacts`, the discrete `(Predicate, Object)` claims behind it —',
				'live, these are things the player told Roomie about themselves.',
				'',
				'Both are empty here. Nothing on this server observes a conversation, so there is',
				'nothing to remember, and Roomie starts every session knowing nothing about who it is',
				'talking to. A flat body, like the Maker AI balances and unlike the access check',
				'above.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(RoomieUserFacts, 'An empty profile — always'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ UserContext: '', UserFacts: [] })
		}
	)

	// Whether the caller may use Maker AI at all. Granted, like the Roomie budget reads and
	// unlike the Game AI checks: this is a gate, not a model call, and refusing it hides the
	// feature outright. (The balances below are still zeroed: the client reads its usage
	// meter separately, and a server that bills nothing has spent nothing.)
	//
	// The envelope is its own shape again — PascalCase `Success`/`Error` beside a snake_case
	// `error_id`, which is neither the Game AI refusal's all-lowercase body nor the Roomie
	// check's `{ success, error_id, error, value }`. Reproduced as the reference sends it;
	// the mixed casing is not a typo to tidy up.
	.get(
		'/makerai/user/access',
		describeRoute({
			tags: ['Maker AI', '2025'],
			summary: 'May the caller use Maker AI?',
			description: [
				'Asked before the client offers Maker AI. Always granted — the gate is about',
				'entitlement, not capacity, and nothing here meters what Maker AI would cost.',
				'',
				'The envelope carries PascalCase `Success`/`Error` next to a snake_case `error_id`,',
				'which matches neither neighbour on this worker. That mix is what the reference sends;',
				'it is not an inconsistency to clean up.',
				'',
				'`roomInstanceSpecificCheck` (the client sends .NET’s `True`/`False`) is accepted and',
				'ignored: it asks whether the check is about the instance the player is standing in',
				'rather than the account, and the answer is the same either way. The token is still',
				'validated first.',
			].join(' '),
			security: AUTHED,
			parameters: [
				boolQuery(
					'roomInstanceSpecificCheck',
					'Whether to check the current room instance rather than the account. Ignored.'
				),
			],
			responses: {
				200: json(MakerAiAccessResponse, 'Always granted'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({ Success: true, Error: null, error_id: null })
		}
	)

	// Maker AI's dollar balances. Zeroed rather than refused: the client reads these to
	// render a usage meter, and a server that bills nothing has spent nothing.
	.get(
		'/makerai/user/balances',
		describeRoute({
			tags: ['Maker AI', '2025'],
			summary: 'The caller’s Maker AI usage balances',
			description: [
				'What Maker AI has cost the caller. Live, these meter model usage in DOLLARS against',
				'a per-user ceiling and a separate RR+ allowance, and the client renders them as a',
				'usage bar with a status word.',
				'',
				'Nothing here bills for model usage, so every figure is zero and both usage buckets',
				'report `Good` — an untouched allowance, not an exhausted one. The time bucket is',
				'`Empty` with `TimeExpiresAt` at `DateTime.MinValue`, this server selling no timed',
				'access for it to hold.',
				'',
				'A flat body — no `{ success, error, value }` envelope, unlike the Roomie access check.',
			].join(' '),
			security: AUTHED,
			responses: {
				200: json(MakerAiBalances, 'All zero — nothing is metered here'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			return c.json({
				UsageDollars: 0,
				UsersMaxUsageDollars: 0,
				RRPlusUsageDollars: 0,
				UsersMaxRRPlusUsageDollars: 0,
				TimeBalanceStatus: 'Empty',
				TimeExpiresAt: '0001-01-01T00:00:00',
				UsageBalanceStatus: 'Good',
				UsagePercent: 0,
				RRPlusUsageBalanceStatus: 'Good',
				RRPlusUsagePercent: 0,
			})
		}
	)

	// Mint an ephemeral OpenAI credential for the client-side Roomie realtime connection.
	.post(
		'/realtime-session/create',
		describeRoute({
			tags: ['Roomie AI', '2025'],
			summary: 'Open a realtime AI session',
			description: [
				'Posted when the player actually pulls out an assistant. Live, this mints a short-',
				'lived credential the CLIENT then uses to talk to the model provider directly, and',
				'answers with `{ SessionId, ClientSecret }` in `value`.',
				'',
				'The permanent OpenAI key stays server-side. Only a short-lived client secret and',
				'session id are returned. Session creation requires an optional OPENAIKEY binding.',
				'',
				'Failures are 200s with `success: false`, an empty `error_id`, and null `value`.',
			].join(' '),
			security: AUTHED,
			requestBody: jsonBody(
				RealtimeSessionCreateBody,
				'Which assistant is being opened. Optional; extra fields are ignored.'
			),
			responses: {
				200: json(RealtimeSessionCreateResponse, 'Session credentials or a failure envelope'),
				401: UNAUTHORIZED_RESPONSE,
			},
		}),
		async (c) => {
			const id = await authedId(c)
			if (id === null) return unauthorized(c)

			const body: unknown = await c.req.json().catch(() => null)
			const aiTypeValue =
				body && typeof body === 'object' && !Array.isArray(body)
					? (body as Record<string, unknown>).AIType
					: undefined
			const aiType = safeDiagnostic(aiTypeValue, /^[\w-]{1,64}$/)
			const model = c.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL
			const logContext = {
				accountId: id,
				aiType,
				model: safeDiagnostic(model, /^[A-Za-z0-9_.-]{1,128}$/),
			}

			try {
				const key = await c.env.OPENAIKEY?.get()
				if (!nonEmptyString(key)) {
					console.warn('Roomie realtime session not configured', logContext)
					return realtimeFailure(c, 'Realtime AI is not configured on this server')
				}

				const response = await fetch(OPENAI_CLIENT_SECRETS_URL, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${key}`,
						'Content-Type': 'application/json',
						'OpenAI-Safety-Identifier': await safetyIdentifier(id),
					},
					body: JSON.stringify({ session: { type: 'realtime', model } }),
					signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
				})
				const requestId = safeDiagnostic(
					response.headers.get('x-request-id'),
					/^req_[A-Za-z0-9_-]{1,128}$/
				)
				const diagnostics = { ...logContext, status: response.status, requestId }
				if (!response.ok) {
					console.warn('OpenAI realtime session creation failed', diagnostics)
					return realtimeFailure(c, 'Failed to create realtime AI session')
				}

				const payload: unknown = await response.json().catch(() => null)
				const session =
					payload && typeof payload === 'object' && !Array.isArray(payload)
						? (payload as Record<string, unknown>).session
						: null
				const sessionId =
					session && typeof session === 'object' && !Array.isArray(session)
						? (session as Record<string, unknown>).id
						: null
				const clientSecret =
					payload && typeof payload === 'object' && !Array.isArray(payload)
						? (payload as Record<string, unknown>).value
						: null
				if (!nonEmptyString(sessionId) || !nonEmptyString(clientSecret)) {
					console.warn('OpenAI returned an invalid realtime session', diagnostics)
					return realtimeFailure(c, 'OpenAI returned an invalid realtime session')
				}

				const expiresAt = (payload as Record<string, unknown>).expires_at
				console.info('Roomie realtime session created', {
					...diagnostics,
					sessionId: safeDiagnostic(sessionId, /^sess_[A-Za-z0-9_-]{1,128}$/),
					expiresAt:
						typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : undefined,
				})
				return c.json({
					success: true,
					error: null,
					error_id: null,
					value: { SessionId: sessionId, ClientSecret: clientSecret },
				})
			} catch {
				console.warn('OpenAI realtime session request failed', logContext)
				return realtimeFailure(c, 'Failed to create realtime AI session')
			}
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
					title: 'recflare ai',
					version: '1.0.0',
					description: [
						'The AI service for recflare, a private-server reimplementation of the Rec Room',
						'backend. The client checks here before offering any of its AI features: Game AI in a',
						'room, the Roomie assistant, and Maker AI’s usage meter.',
						'',
						'Game AI access is granted in the two named test rooms; model execution is not',
						'implemented. Roomie and Maker AI budget reads are granted in full because nothing here',
						'meters usage. `POST /realtime-session/create` mints short-lived OpenAI credentials',
						'for Roomie when OPENAIKEY is configured.',
						'',
						'Failures are 200s carrying `success: false`, which is the shape the client',
						'branches on — the worker exists so the client gets a definite answer on the host its',
						'endpoints document names, instead of a failed request.',
					].join('\n'),
				},
				servers: [{ url: 'https://ai.recflare.net', description: 'Production' }],
				components: {
					securitySchemes: {
						bearerAuth: {
							type: 'http',
							scheme: 'bearer',
							bearerFormat: 'JWT',
							description: 'An `access_token` from the auth worker’s `POST /connect/token`.',
						},
					},
				},
			},
		})
	)
)

export default app
