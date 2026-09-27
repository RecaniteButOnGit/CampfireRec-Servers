import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { sign } from 'hono/jwt'
import { beforeAll, describe, expect, test, vi } from 'vitest'

import '../../auth.app'

import { SCHEMA_DDL } from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { generatePhotonAuthToken, generateToken } from '@repo/jwt'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const ORIGIN = 'https://example.com'
const SECRET = 'photon-test-signing-key'
const AUDIENCE = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = 42

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create(SECRET)
	env.PHOTON_REALTIME_APP_ID = AUDIENCE
	for (const stmt of SCHEMA_DDL) await env.DB.prepare(stmt).run()
	await env.DB.prepare('INSERT INTO account (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId: ACCOUNT_ID, username: 'PhotonPlayer' }))
		.run()
})

function token(secret = SECRET, audience = AUDIENCE, accountId = ACCOUNT_ID): Promise<string> {
	return generatePhotonAuthToken(
		accountId,
		{ platformId: 'test-platform', platform: 0, deviceClass: 2, audience },
		secret
	)
}

function expiredToken(): Promise<string> {
	return sign(
		{
			sub: String(ACCOUNT_ID),
			'rn.platid': 'test-platform',
			'rn.plat': '0',
			'rn.deviceclass': '2',
			'rn.env': 'prod',
			exp: Math.floor(Date.now() / 1000) - 60,
			aud: AUDIENCE,
		},
		SECRET
	)
}

async function request(
	path: string | Request,
	init?: RequestInit
): Promise<{
	status: number
	contentType: string | null
	body: Record<string, unknown>
	text: string
}> {
	const response = await exports.default.fetch(
		typeof path === 'string' ? `${ORIGIN}${path}` : path,
		init
	)
	const text = await response.text()
	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		body: JSON.parse(text) as Record<string, unknown>,
		text,
	}
}

/** Fetch creates text/plain for string bodies; remove it to model Photon's request. */
function unlabeledPost(body: string): ReturnType<typeof request> {
	const raw = new Request(`${ORIGIN}/photon/authenticate`, { method: 'POST', body })
	raw.headers.delete('content-type')
	expect(raw.headers.has('content-type')).toBe(false)
	return request(raw)
}

function expectPhotonResponse(result: Awaited<ReturnType<typeof request>>, code: number): void {
	expect(result.status).toBe(200)
	expect(result.contentType).toContain('application/json')
	expect(result.body.ResultCode).toBe(code)
	expect(result.body).not.toHaveProperty('success')
	expect(result.body).not.toHaveProperty('value')
	expect(result.body).not.toHaveProperty('error')
}

describe('Photon Cloud Custom Authentication', () => {
	test('GET route exists and missing token has Photon invalid-parameters shape', async () => {
		const result = await request('/photon/authenticate')
		expectPhotonResponse(result, 3)
		expect(result.body).toEqual({ ResultCode: 3, Message: 'Invalid authentication parameters.' })
	})

	test('valid production-helper token in primary GET parameter identifies the account', async () => {
		const result = await request(
			`/photon/authenticate?photonAuthToken=${encodeURIComponent(await token())}`
		)
		expectPhotonResponse(result, 1)
		expect(result.body).toEqual({ ResultCode: 1, UserId: String(ACCOUNT_ID) })
	})

	test.each(['authToken', 'token', 'accessToken'])(
		'GET alias %s accepts the same credential',
		async (name) => {
			const result = await request(
				`/photon/authenticate?${name}=${encodeURIComponent(await token())}`
			)
			expectPhotonResponse(result, 1)
		}
	)

	test('POST JSON and form token transports succeed', async () => {
		const credential = await token()
		for (const [contentType, body] of [
			['application/json', JSON.stringify({ photonAuthToken: credential })],
			[
				'application/x-www-form-urlencoded',
				new URLSearchParams({ photonAuthToken: credential }).toString(),
			],
		] as const) {
			const result = await request('/photon/authenticate', {
				method: 'POST',
				headers: { 'Content-Type': contentType },
				body,
			})
			expectPhotonResponse(result, 1)
			expect(result.body.UserId).toBe(String(ACCOUNT_ID))
		}
	})

	test('POST may carry the token in the query alongside other body fields', async () => {
		const credential = await token()
		const result = await request(
			`/photon/authenticate?photonAuthToken=${encodeURIComponent(credential)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ region: 'us' }),
			}
		)
		expectPhotonResponse(result, 1)
	})

	test('POST text/plain form-style and raw JWT transports succeed', async () => {
		const credential = await token()
		for (const [contentType, body] of [
			['text/plain', `photonAuthToken=${credential}`],
			['text/plain', credential],
			['text/plain', JSON.stringify({ photonAuthToken: credential })],
			['application/octet-stream', credential],
		] as const) {
			const result = await request('/photon/authenticate', {
				method: 'POST',
				headers: { 'Content-Type': contentType },
				body,
			})
			expectPhotonResponse(result, 1)
		}
	})

	test('unlabeled raw JWT body succeeds after cryptographic verification', async () => {
		const result = await unlabeledPost(`\n${await token()}\n`)
		expectPhotonResponse(result, 1)
		expect(result.body.UserId).toBe(String(ACCOUNT_ID))
	})

	test.each(['photonAuthToken', 'authToken', 'token'])(
		'unlabeled form body accepts %s with percent encoding',
		async (name) => {
			const form = new URLSearchParams({ [name]: await token() }).toString().replaceAll('.', '%2E')
			const result = await unlabeledPost(form)
			expectPhotonResponse(result, 1)
			expect(result.body.UserId).toBe(String(ACCOUNT_ID))
		}
	)

	test.each(['photonAuthToken', 'authToken', 'token'])(
		'unlabeled JSON object accepts %s',
		async (name) => {
			const result = await unlabeledPost(JSON.stringify({ [name]: await token() }))
			expectPhotonResponse(result, 1)
		}
	)

	test('real 2025 unlabeled JSON payload authenticates from accessToken', async () => {
		const result = await unlabeledPost(
			JSON.stringify({
				accountId: String(ACCOUNT_ID),
				accessToken: await token(),
			})
		)
		expectPhotonResponse(result, 1)
		expect(result.body).toEqual({ ResultCode: 1, UserId: String(ACCOUNT_ID) })
	})

	test('accessToken with accountId also works as application/json', async () => {
		const result = await request('/photon/authenticate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ accountId: String(ACCOUNT_ID), accessToken: await token() }),
		})
		expectPhotonResponse(result, 1)
		expect(result.body.UserId).toBe(String(ACCOUNT_ID))
	})

	test('unsigned accountId is optional but must match the verified subject when supplied', async () => {
		const credential = await token()
		expectPhotonResponse(await unlabeledPost(JSON.stringify({ accessToken: credential })), 1)
		for (const suppliedId of ['999', null, { id: ACCOUNT_ID }]) {
			const result = await unlabeledPost(
				JSON.stringify({ accountId: suppliedId, accessToken: credential })
			)
			expectPhotonResponse(result, 2)
			expect(result.body).toEqual({ ResultCode: 2, Message: 'Authentication failed.' })
		}
		expectPhotonResponse(await unlabeledPost(JSON.stringify({ accountId: String(ACCOUNT_ID) })), 3)
	})

	test('live accessToken field distinguishes invalid credentials from missing parameters', async () => {
		for (const credential of [
			'invalid',
			await token('different-test-secret'),
			await token(SECRET, 'another-photon-app'),
			await expiredToken(),
			await token(SECRET, AUDIENCE, 99999),
		]) {
			const result = await unlabeledPost(
				JSON.stringify({
					accountId: String(ACCOUNT_ID),
					accessToken: credential,
				})
			)
			expectPhotonResponse(result, 2)
			expect(result.text).not.toContain(credential)
		}
	})

	test('conflicting accessToken and token are rejected, matching values are accepted', async () => {
		const credential = await token()
		expectPhotonResponse(
			await unlabeledPost(
				JSON.stringify({
					accessToken: credential,
					token: await token(SECRET, 'another-photon-app'),
				})
			),
			3
		)
		expectPhotonResponse(
			await unlabeledPost(
				JSON.stringify({
					accessToken: credential,
					token: credential,
				})
			),
			1
		)
	})

	test.each([
		'hello',
		'thing=value',
		'{"foo":"bar"}',
		'[]',
		'{"photonAuthToken":{"nested":"value"}}',
	])('unlabeled body %s has invalid parameters', async (body) => {
		const result = await unlabeledPost(body)
		expectPhotonResponse(result, 3)
	})

	test('unlabeled form with conflicting token names is rejected', async () => {
		const body = new URLSearchParams({
			photonAuthToken: await token(),
			token: await token(SECRET, 'another-photon-app'),
		}).toString()
		expectPhotonResponse(await unlabeledPost(body), 3)
	})

	test('an unlabeled, parsed token with a bad signature is an authentication failure', async () => {
		const result = await unlabeledPost(`photonAuthToken=${await token('different-test-secret')}`)
		expectPhotonResponse(result, 2)
	})

	test('request diagnostics report structure without credential values', async () => {
		const credential = await token()
		const info = vi.spyOn(logger, 'info')
		try {
			expectPhotonResponse(await unlabeledPost(`photonAuthToken=${credential}&username=Player`), 1)
			const log = info.mock.calls.find(([message]) => message === 'Photon auth request')
			expect(log?.[1]).toMatchObject({
				method: 'POST',
				contentType: '',
				bodyKeys: ['photonAuthToken', 'username'],
				bodyFormat: 'form',
				bodyLength: expect.any(Number),
			})
			expectPhotonResponse(await unlabeledPost(JSON.stringify({ photonAuthToken: credential })), 1)
			const jsonLog = info.mock.calls
				.filter(([message]) => message === 'Photon auth request')
				.at(-1)
			expect(jsonLog?.[1]).toMatchObject({
				bodyFormat: 'json-object',
				bodyKeys: ['photonAuthToken'],
			})
			expectPhotonResponse(
				await unlabeledPost(
					JSON.stringify({
						accountId: String(ACCOUNT_ID),
						accessToken: credential,
					})
				),
				1
			)
			const liveLog = info.mock.calls
				.filter(([message]) => message === 'Photon auth request')
				.at(-1)
			expect(liveLog?.[1]).toMatchObject({
				contentType: '',
				bodyFormat: 'json-object',
				bodyKeys: ['accountId', 'accessToken'],
			})
			expectPhotonResponse(await unlabeledPost('auth.token=value'), 3)
			const namedLog = info.mock.calls
				.filter(([message]) => message === 'Photon auth request')
				.at(-1)
			expect(namedLog?.[1]).toMatchObject({ bodyFormat: 'form', bodyKeys: ['auth.token'] })
			expectPhotonResponse(await unlabeledPost(`${credential}=value`), 3)
			const logged = JSON.stringify(info.mock.calls)
			expect(logged).not.toContain(credential)
			expect(logged).not.toContain(SECRET)
			expect(logged).not.toContain('eyJ')
			expect(logged).not.toContain('Player')
		} finally {
			info.mockRestore()
		}
	})

	test('unknown-body diagnostics contain only a structural fingerprint', async () => {
		const info = vi.spyOn(logger, 'info')
		try {
			expectPhotonResponse(await unlabeledPost('[unknown.secret=value]'), 3)
			const log = info.mock.calls.find(([message]) => message === 'Photon auth request')
			expect(log?.[1]).toMatchObject({
				bodyFormat: 'unknown',
				bodyKeys: [],
				containsEquals: true,
				startsWithBracket: true,
				jwtDotCount: 1,
			})
			expect(JSON.stringify(info.mock.calls)).not.toContain('unknown.secret=value')
		} finally {
			info.mockRestore()
		}
	})

	test('invalid signature, expiration, audience, and missing account are rejected', async () => {
		const expired = await expiredToken()
		const withoutExpiry = await sign(
			{
				sub: String(ACCOUNT_ID),
				'rn.platid': 'test-platform',
				'rn.plat': '0',
				'rn.deviceclass': '2',
				'rn.env': 'prod',
				aud: AUDIENCE,
			},
			SECRET
		)
		for (const credential of [
			await token('different-test-secret'),
			expired,
			withoutExpiry,
			await token(SECRET, 'another-photon-app'),
			await token(SECRET, AUDIENCE, 99999),
			await generateToken(String(ACCOUNT_ID), 'test-platform', 0, SECRET),
		]) {
			const result = await request(
				`/photon/authenticate?photonAuthToken=${encodeURIComponent(credential)}`
			)
			expectPhotonResponse(result, 2)
			expect(result.body).toEqual({ ResultCode: 2, Message: 'Authentication failed.' })
			expect(result.text).not.toContain(credential)
			expect(result.text).not.toContain(SECRET)
			expect(result.text).not.toContain('stack')
		}
	})

	test('malformed parameters and unknown content types do not authenticate', async () => {
		for (const init of [
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' },
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream' },
				body: 'not a JWT',
			},
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId: ACCOUNT_ID }),
			},
		]) {
			const result = await request('/photon/authenticate', init)
			expectPhotonResponse(result, 3)
		}
	})

	test('conflicting token aliases are invalid parameters', async () => {
		const result = await request('/photon/authenticate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				photonAuthToken: await token(),
				authToken: await token(SECRET, 'other-app'),
			}),
		})
		expectPhotonResponse(result, 3)
	})
})
