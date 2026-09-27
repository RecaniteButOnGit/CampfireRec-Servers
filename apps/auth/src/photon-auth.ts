import { getAccount } from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetPhotonAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { App } from './context'

const TOKEN_KEYS = ['photonAuthToken', 'authToken', 'token'] as const
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

type Fields = Record<string, unknown>

function safeKeys(keys: Iterable<string>): string[] {
	return [...keys].map((key) => (key.length <= 64 && !JWT_SHAPE.test(key) ? key : '[redacted]'))
}

function fieldsFromParams(params: URLSearchParams): Fields {
	const fields: Fields = Object.create(null) as Fields
	for (const key of params.keys()) {
		const values = params.getAll(key)
		fields[key] = values.length === 1 ? values[0] : values
	}
	return fields
}

async function readBody(request: Request): Promise<{ fields: Fields; rawToken?: string }> {
	if (request.method !== 'POST') return { fields: {} }
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
	const body = new TextDecoder().decode(await request.arrayBuffer())
	if (contentType === 'application/json') {
		try {
			const parsed: unknown = JSON.parse(body)
			return {
				fields:
					parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Fields) : {},
			}
		} catch {
			return { fields: {} }
		}
	}
	if (contentType === 'application/x-www-form-urlencoded') {
		return { fields: fieldsFromParams(new URLSearchParams(body)) }
	}
	if (contentType === 'text/plain') {
		// Some Photon configurations send form-style parameters as plain text.
		const params = new URLSearchParams(body)
		if (TOKEN_KEYS.some((key) => params.has(key))) return { fields: fieldsFromParams(params) }
	}
	// An unlabelled/plain raw body is allowed only when the whole body is a JWT.
	return JWT_SHAPE.test(body) ? { fields: {}, rawToken: body } : { fields: {} }
}

function findToken(query: Fields, body: Fields, rawToken?: string): string | null {
	const values: unknown[] = []
	for (const fields of [query, body]) {
		for (const key of TOKEN_KEYS) {
			if (Object.hasOwn(fields, key)) values.push(fields[key])
		}
	}
	if (rawToken) values.push(rawToken)
	if (values.length === 0 || values.some((value) => typeof value !== 'string' || !value))
		return null
	const token = values[0] as string
	return values.every((value) => value === token) ? token : null
}

const invalidParameters = { ResultCode: 3, Message: 'Invalid authentication parameters.' } as const
const authenticationFailed = { ResultCode: 2, Message: 'Authentication failed.' } as const

/** Photon Cloud's server-to-server Custom Authentication callback. */
export async function photonAuthenticate(c: Context<App>): Promise<Response> {
	let queryKeys: string[] = []
	let bodyKeys: string[] = []
	let contentType = ''
	try {
		const query = fieldsFromParams(new URL(c.req.url).searchParams)
		const body = await readBody(c.req.raw)
		queryKeys = safeKeys(Object.keys(query))
		bodyKeys = safeKeys(Object.keys(body.fields))
		contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
		logger.info('Photon auth request', { method: c.req.method, contentType, queryKeys, bodyKeys })

		const token = findToken(query, body.fields, body.rawToken)
		if (!token) {
			logger.info('Photon auth rejected', { category: 'invalid_parameters' })
			return c.json(invalidParameters)
		}

		const audience = c.env.PHOTON_REALTIME_APP_ID?.trim() ?? ''
		if (!audience) {
			logger.error('Photon auth missing Realtime app ID')
			return c.json(authenticationFailed)
		}
		const accountId = await validateAndGetPhotonAccountId(
			token,
			await c.env.JWT_SECRET.get(),
			audience
		)
		if (accountId === null) {
			logger.info('Photon auth rejected', { category: 'invalid_token' })
			return c.json(authenticationFailed)
		}
		if (!(await getAccount(c.env.DB, accountId))) {
			logger.info('Photon auth rejected', { category: 'unknown_account' })
			return c.json(authenticationFailed)
		}
		logger.info('Photon auth accepted', { accountId })
		return c.json({ ResultCode: 1, UserId: String(accountId) })
	} catch (error) {
		// An infrastructure failure is still a valid Photon response, while the
		// underlying error stays in server logs for diagnosis.
		logger.error(error)
		return c.json(authenticationFailed)
	}
}
