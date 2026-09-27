import { getAccount } from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetPhotonAccountId, validateAndGetRecNetAccessTokenAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { App } from './context'

const TOKEN_KEYS = ['photonAuthToken', 'authToken', 'token', 'accessToken'] as const
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,63}$/
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

type Fields = Record<string, unknown>
type BodyFormat = 'empty' | 'raw-jwt' | 'form' | 'json-object' | 'unknown'
type ParsedBody = {
	fields: Fields
	rawToken?: string
	format: BodyFormat
	bodyLength: number
	fingerprint?: {
		containsEquals: boolean
		containsAmpersand: boolean
		startsWithBrace: boolean
		startsWithBracket: boolean
		jwtDotCount: number
	}
}

function safeKeys(keys: Iterable<string>): string[] {
	return [...keys].map((key) =>
		FIELD_NAME.test(key) && !JWT_SHAPE.test(key) && !/eyJ[A-Za-z0-9_-]{8,}/.test(key)
			? key
			: '[redacted]'
	)
}

function fieldsFromParams(params: URLSearchParams): Fields {
	const fields: Fields = Object.create(null) as Fields
	for (const key of params.keys()) {
		const values = params.getAll(key)
		fields[key] = values.length === 1 ? values[0] : values
	}
	return fields
}

function jsonObject(body: string): Fields | null {
	try {
		const parsed: unknown = JSON.parse(body)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Fields)
			: null
	} catch {
		return null
	}
}

/** Parse only the supported Photon transports; never search arbitrary values for a JWT. */
function parsePhotonAuthBody(body: string, contentType: string): ParsedBody {
	const bodyLength = body.length
	const empty = { fields: {}, format: 'empty', bodyLength } as const
	if (!body) return empty

	if (contentType === 'application/json') {
		const fields = jsonObject(body)
		if (fields) return { fields, format: 'json-object', bodyLength }
	} else if (contentType === 'application/x-www-form-urlencoded') {
		return { fields: fieldsFromParams(new URLSearchParams(body)), format: 'form', bodyLength }
	} else {
		const trimmed = body.trim()
		if (JWT_SHAPE.test(trimmed))
			return { fields: {}, rawToken: trimmed, format: 'raw-jwt', bodyLength }
		if (contentType === '' || contentType === 'text/plain') {
			// A form is recognized by its parameter names, not by arbitrary values.
			// In particular, do not turn a JSON body containing '=' into a form key.
			if (body.includes('=')) {
				const params = new URLSearchParams(body)
				if ([...params.keys()].every((key) => FIELD_NAME.test(key))) {
					return { fields: fieldsFromParams(params), format: 'form', bodyLength }
				}
			}
			const fields = jsonObject(body)
			if (fields) return { fields, format: 'json-object', bodyLength }
		}
	}

	return {
		fields: {},
		format: 'unknown',
		bodyLength,
		fingerprint: {
			containsEquals: body.includes('='),
			containsAmpersand: body.includes('&'),
			startsWithBrace: body.trimStart().startsWith('{'),
			startsWithBracket: body.trimStart().startsWith('['),
			jwtDotCount: (body.match(/\./g) ?? []).length,
		},
	}
}

async function readBody(request: Request): Promise<ParsedBody> {
	if (request.method !== 'POST') return { fields: {}, format: 'empty', bodyLength: 0 }
	const contentType =
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
	const body = new TextDecoder().decode(await request.arrayBuffer())
	return parsePhotonAuthBody(body, contentType)
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

/** An unsigned accountId may corroborate the JWT subject, never establish identity. */
function accountIdMatches(query: Fields, body: Fields, verifiedId: number): boolean {
	for (const fields of [query, body]) {
		if (!Object.hasOwn(fields, 'accountId')) continue
		const supplied = fields.accountId
		if (
			(typeof supplied !== 'string' && typeof supplied !== 'number') ||
			String(supplied) !== String(verifiedId)
		)
			return false
	}
	return true
}

const invalidParameters = { ResultCode: 3, Message: 'Invalid authentication parameters.' } as const
const authenticationFailed = { ResultCode: 2, Message: 'Authentication failed.' } as const

/** Photon Cloud's server-to-server Custom Authentication callback. */
export async function photonAuthenticate(c: Context<App>): Promise<Response> {
	try {
		const query = fieldsFromParams(new URL(c.req.url).searchParams)
		const body = await readBody(c.req.raw)
		const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
		logger.info('Photon auth request', {
			method: c.req.method,
			contentType:
				mediaType === '' || (mediaType.length <= 64 && MEDIA_TYPE.test(mediaType))
					? mediaType
					: '[invalid]',
			queryKeys: safeKeys(Object.keys(query)),
			bodyKeys: safeKeys(Object.keys(body.fields)),
			bodyLength: body.bodyLength,
			bodyFormat: body.format,
			...(body.fingerprint ?? {}),
		})

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
		const secret = await c.env.JWT_SECRET.get()
		let accountId = await validateAndGetPhotonAccountId(token, secret, audience)
		let credentialType: 'photon' | 'recnet' | 'unknown' = 'photon'
		if (accountId === null) {
			accountId = await validateAndGetRecNetAccessTokenAccountId(token, secret)
			credentialType = accountId === null ? 'unknown' : 'recnet'
		}
		logger.info('Photon auth credential classified', { credentialType })
		if (accountId === null) {
			logger.info('Photon auth rejected', { category: 'unsupported_credential' })
			return c.json(authenticationFailed)
		}
		if (!accountIdMatches(query, body.fields, accountId)) {
			logger.info('Photon auth rejected', { category: 'account_mismatch' })
			return c.json(authenticationFailed)
		}
		if (!(await getAccount(c.env.DB, accountId))) {
			logger.info('Photon auth rejected', { category: 'unknown_account' })
			return c.json(authenticationFailed)
		}
		logger.info('Photon auth accepted', { accountId, credentialType })
		return c.json({ ResultCode: 1, UserId: String(accountId) })
	} catch (error) {
		// An infrastructure failure is still a valid Photon response, while the
		// underlying error stays in server logs for diagnosis.
		logger.error(error)
		return c.json(authenticationFailed)
	}
}
