import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import aiApp from '../../ai.app'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'

beforeAll(async () => {
	// Seed the shared JWT signing key into the local Secrets Store so .get() resolves.
	await adminSecretsStore(env.JWT_SECRET).create('test-signing-key')
})

// Mint a token the way the `auth` worker does, signing with the shared test key seeded
// into the JWT_SECRET store.
const TEST_SECRET = 'test-signing-key'

function b64url(input: ArrayBuffer | string): string {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function bearer(sub = '42'): Promise<Record<string, string>> {
	const now = Math.floor(Date.now() / 1000)
	const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ sub, exp: now + 3600 })
	)}`
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TEST_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	return { Authorization: `Bearer ${signingInput}.${b64url(sig)}` }
}

const REFUSAL = {
	success: false,
	error_id: 'AI.RoomDoesNotSupportGameAI',
	error: 'This room does not support Rec Room Game AI',
}

describe('ai endpoints', () => {
	it('GET / reports service status', async () => {
		const res = await SELF.fetch(`${ORIGIN}/`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ service: 'ai', status: 'ok' })
	})
})

describe('GET /gameai/user/access', () => {
	// A refusal, not an HTTP error: the client branches on the body, so a 4xx here would
	// read as a failed request rather than "Game AI isn't available in this room".
	it('refuses with a 200 body', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/user/access?roomId=1234`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(REFUSAL)
	})

	// `roomId` is optional in the reference signature and ignored here, so both forms and
	// any room answer identically.
	it.each(['', '?roomId=1', '?roomId=18446744073709551615'])(
		'answers the same for %s',
		async (query) => {
			const res = await SELF.fetch(`${ORIGIN}/gameai/user/access${query}`, {
				headers: await bearer(),
			})
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual(REFUSAL)
		}
	)

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/user/access?roomId=1234`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})

	it('401s with a garbage token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/user/access`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('GET /roomieai/user/access', () => {
	// Granted, unlike the Game AI check: Roomie runs on the client and only asks for its
	// energy budget, which nothing here meters.
	it('grants an int32-max energy budget', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			success: true,
			error_id: null,
			error: null,
			value: {
				// int.MaxValue — the client's field is a signed 32-bit int, so a larger number
				// overflows on the way in and reads as negative, i.e. no energy at all.
				MaxEnergyFromSubscriptions: 2147483647,
				EnergyLeft: 2147483647,
				NextSubscriptionEnergyRechargeAt: null,
				OutputAudioEnabled: true,
			},
		})
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})

	it('401s with a garbage token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/access`, {
			headers: { Authorization: 'Bearer not-a-real-token' },
		})
		expect(res.status).toBe(401)
	})
})

describe('GET /gameai/room/:roomId/spendsummary', () => {
	// Same refusal as the access check but with an explicit `value: null` — the access
	// check omits the key. toEqual pins that difference: don't unify the two shapes.
	it('refuses with a 200 body carrying a null value', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/room/1234/spendsummary`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ...REFUSAL, value: null })
	})

	// Room ids are ulong on the wire, so the largest one has 20 digits and exceeds what a
	// JS number holds exactly. It's never parsed here, only matched by the route pattern.
	it.each(['1', '18446744073709551615'])('answers the same for room %s', async (roomId) => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/room/${roomId}/spendsummary`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ...REFUSAL, value: null })
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/gameai/room/1234/spendsummary`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('GET /roomieai/user/facts', () => {
	// Nothing observes players here, so Roomie's memory of the caller is empty — and empty
	// in both halves: no prose profile, no facts behind one.
	it('reports an empty profile', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/facts`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ UserContext: '', UserFacts: [] })
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/roomieai/user/facts`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('GET /makerai/user/access', () => {
	// Granted, and pinned whole: the casing is mixed on purpose (PascalCase `Success`/`Error`
	// beside a snake_case `error_id`) and matches neither neighbour on this worker, so a
	// "consistency" edit has to fail here rather than on the client.
	it('grants access', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/access?roomInstanceSpecificCheck=True`, {
			headers: await bearer(),
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('application/json')
		expect(await res.json()).toEqual({ Success: true, Error: null, error_id: null })
	})

	it('answers the same without the query param', async () => {
		// `roomInstanceSpecificCheck` is ignored, so its presence, absence and value change
		// nothing.
		const granted = { Success: true, Error: null, error_id: null }
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/access`, { headers: await bearer() })
		expect(await res.json()).toEqual(granted)
		const falseCheck = await SELF.fetch(
			`${ORIGIN}/makerai/user/access?roomInstanceSpecificCheck=False`,
			{
				headers: await bearer(),
			}
		)
		expect(await falseCheck.json()).toEqual(granted)
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/access`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('GET /makerai/user/balances', () => {
	// Zeroed rather than refused: the client renders a usage meter from these, and a server
	// that bills nothing has spent nothing. A flat body — no envelope.
	it('reports zeroed balances', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/balances`, { headers: await bearer() })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			UsageDollars: 0,
			UsersMaxUsageDollars: 0,
			RRPlusUsageDollars: 0,
			UsersMaxRRPlusUsageDollars: 0,
			// An untouched allowance reports `Good`; the time bucket is `Empty` at
			// DateTime.MinValue, this server selling no timed access to hold there.
			TimeBalanceStatus: 'Empty',
			TimeExpiresAt: '0001-01-01T00:00:00',
			UsageBalanceStatus: 'Good',
			UsagePercent: 0,
			RRPlusUsageBalanceStatus: 'Good',
			RRPlusUsagePercent: 0,
		})
	})

	it('401s without a bearer token', async () => {
		const res = await SELF.fetch(`${ORIGIN}/makerai/user/balances`)
		expect(res.status).toBe(401)
		expect(await res.text()).toBe('')
	})
})

describe('POST /realtime-session/create', () => {
	const OPENAIKEY = 'sk-test-server-secret'
	const failure = (error: string) => ({ success: false, error, error_id: '', value: null })
	const success = {
		success: true,
		error: null,
		error_id: null,
		value: { SessionId: 'sess_test', ClientSecret: 'ek_test' },
	}

	async function create(
		body: string | null = JSON.stringify({ AIType: 'Roomie' }),
		options: { key?: string; model?: string; authorized?: boolean; authorization?: string } = {}
	) {
		const headers = {
			'Content-Type': 'application/json',
			...(options.authorized === false
				? {}
				: options.authorization
					? { Authorization: options.authorization }
					: await bearer()),
		}
		return aiApp.fetch(
			new Request(`${ORIGIN}/realtime-session/create`, {
				method: 'POST',
				headers,
				body: body ?? undefined,
			}),
			{
				...env,
				OPENAIKEY: options.key === undefined ? undefined : { get: async () => options.key },
				OPENAI_REALTIME_MODEL: options.model,
			} as never,
			{} as never
		)
	}

	afterEach(() => vi.restoreAllMocks())

	it('401s on missing or invalid bearer tokens without contacting OpenAI', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch')
		for (const options of [
			{ key: OPENAIKEY, authorized: false },
			{ key: OPENAIKEY, authorization: 'Bearer not-a-real-token' },
		]) {
			const res = await create(undefined, options)
			expect(res.status).toBe(401)
			expect(await res.text()).toBe('')
		}
		expect(outbound).not.toHaveBeenCalled()
	})

	it('returns an HTTP 200 failure when OPENAIKEY is missing', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch')
		const res = await create()
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(failure('Realtime AI is not configured on this server'))
		expect(outbound).not.toHaveBeenCalled()
	})

	it('creates a GA client secret using the permanent key and default model', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		const info = vi.spyOn(console, 'info').mockImplementation(() => {})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({
				value: 'ek_test',
				expires_at: 1234567890,
				session: { id: 'sess_test', type: 'realtime' },
			})
		)
		const res = await create(JSON.stringify({ AIType: 'Roomie', Extra: true }), { key: OPENAIKEY })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(success)
		expect(outbound).toHaveBeenCalledTimes(1)
		const [url, init] = outbound.mock.calls[0]
		expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets')
		expect(init?.method).toBe('POST')
		expect(init?.headers).toMatchObject({
			Authorization: `Bearer ${OPENAIKEY}`,
			'Content-Type': 'application/json',
		})
		expect(
			(init?.headers as Record<string, string> | undefined)?.['OpenAI-Safety-Identifier']
		).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.parse(init?.body as string)).toEqual({
			session: { type: 'realtime', model: 'gpt-realtime-2.1-mini' },
		})
		expect(init?.signal).toBeDefined()
		expect(
			JSON.stringify([log.mock.calls, info.mock.calls, warn.mock.calls, error.mock.calls])
		).not.toMatch(/sk-test-server-secret|ek_test/)
	})

	it('uses the configured model and accepts a missing or malformed body', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			Response.json({
				value: 'ek_test',
				session: { id: 'sess_test' },
			})
		)
		for (const body of [null, 'not json']) {
			const res = await create(body, { key: OPENAIKEY, model: 'gpt-realtime-custom' })
			expect(await res.json()).toEqual(success)
		}
		expect(outbound).toHaveBeenCalledTimes(2)
		for (const [, init] of outbound.mock.calls) {
			expect(JSON.parse(init?.body as string)).toEqual({
				session: { type: 'realtime', model: 'gpt-realtime-custom' },
			})
		}
	})

	it('returns a safe failure envelope on an OpenAI error without logging secrets', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		const info = vi.spyOn(console, 'info').mockImplementation(() => {})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: { message: `bad ${OPENAIKEY} ek_should-not-log` } }), {
				status: 429,
				headers: { 'x-request-id': 'req_test' },
			})
		)
		const res = await create(undefined, { key: OPENAIKEY })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(failure('Failed to create realtime AI session'))
		expect(
			JSON.stringify([log.mock.calls, info.mock.calls, warn.mock.calls, error.mock.calls])
		).not.toMatch(/sk-test-server-secret|ek_should-not-log/)
		expect(JSON.stringify(warn.mock.calls)).toContain('req_test')
		expect(JSON.stringify(warn.mock.calls)).toContain('429')
	})

	it.each([
		{ value: '', session: { id: 'sess_test' } },
		{ value: 'ek_test', session: {} },
		{ value: 'ek_test', session: { id: 42 } },
	])('rejects a malformed OpenAI success response: %j', async (payload) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload))
		const res = await create(undefined, { key: OPENAIKEY })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual(failure('OpenAI returned an invalid realtime session'))
	})
})

describe('GET /openapi.json', () => {
	it('documents every route, with no dangling $refs', async () => {
		const res = await SELF.fetch(`${ORIGIN}/openapi.json`)
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			openapi: string
			paths: Record<string, Record<string, { summary?: string }>>
		}
		expect(spec.openapi).toMatch(/^3\.1/)

		// The spec route hides itself; everything else is described. Adding a route without
		// a describeRoute() block fails here rather than shipping an incomplete spec.
		const documented = new Set(
			Object.entries(spec.paths).flatMap(([path, ops]) =>
				Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
			)
		)
		expect([...documented].sort()).toEqual([
			'GET /',
			'GET /gameai/room/{roomId}/spendsummary',
			'GET /gameai/user/access',
			'GET /makerai/user/access',
			'GET /makerai/user/balances',
			'GET /roomieai/user/access',
			'GET /roomieai/user/facts',
			'POST /realtime-session/create',
		])
		const realtimeSpec = JSON.stringify(spec.paths['/realtime-session/create'].post)
		expect(realtimeSpec).toContain('SessionId')
		expect(realtimeSpec).toContain('ClientSecret')
		expect(realtimeSpec).toContain('401')

		for (const ops of Object.values(spec.paths)) {
			for (const op of Object.values(ops)) expect(op.summary).toBeTruthy()
		}

		// Schemas must inline: a `$ref` here is a dangling reference (see openapi.ts).
		expect(JSON.stringify(spec).includes('"$ref"')).toBe(false)
	})
})
