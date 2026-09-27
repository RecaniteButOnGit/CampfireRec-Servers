import { adminSecretsStore, env } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { sign } from 'hono/jwt'
import { beforeAll, describe, expect, test } from 'vitest'

import '../../auth.app'

import { SCHEMA_DDL } from '@repo/domain'
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

async function request(
	path: string,
	init?: RequestInit
): Promise<{
	status: number
	contentType: string | null
	body: Record<string, unknown>
	text: string
}> {
	const response = await exports.default.fetch(`${ORIGIN}${path}`, init)
	const text = await response.text()
	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		body: JSON.parse(text) as Record<string, unknown>,
		text,
	}
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

	test.each(['authToken', 'token'])('GET alias %s accepts the same credential', async (name) => {
		const result = await request(
			`/photon/authenticate?${name}=${encodeURIComponent(await token())}`
		)
		expectPhotonResponse(result, 1)
	})

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

	test('invalid signature, expiration, audience, and missing account are rejected', async () => {
		const expired = await sign(
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
