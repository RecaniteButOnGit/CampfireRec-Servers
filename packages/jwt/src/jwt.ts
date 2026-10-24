/**
 * HS256 JWT generation and validation, built on Hono's `hono/jwt` helpers (Web
 * Crypto under the hood) so we don't hand-roll signing, base64url, or claim
 * (exp/nbf) checks.
 *
 * The signing key is supplied by the caller from the shared `JWT_SECRET` binding
 * (a Cloudflare secret in deployed envs, `.dev.vars` locally) — see each worker's
 * context.ts. `auth` signs tokens; every worker validates them with the same key.
 */

import { sign, verify } from 'hono/jwt'

import { GAME_VERSION, gameBuild } from '@repo/domain'

// Token lifetime in seconds (mirrored in the `expires_in` response field).
// @todo Allegedly, the game is supposed to refresh tokens every 3600 seconds, but it doesn't.
// It's possible our refresh_token implementation is broken, but for now we just make the token
// last a day so the client doesn't have to refresh it.
export const TOKEN_TTL_SECONDS = 86400

/** A build host can validate content and its job's grants, but cannot act as an account. */
export async function generateStudioBuildValidationToken(
	buildId: string,
	secret: string
): Promise<string> {
	return sign(
		{
			aud: 'studio-build-validation',
			scope: 'studio.build.validate',
			buildId,
			exp: Math.floor(Date.now() / 1000) + 8 * 3600,
		},
		secret,
		'HS256'
	)
}

export async function validateStudioBuildValidationToken(
	request: Request,
	secret: string
): Promise<boolean> {
	return (await studioBuildValidationId(request, secret)) !== null
}

/** Signed job identity for read-only, job-scoped validation routes. */
export async function studioBuildValidationId(
	request: Request,
	secret: string
): Promise<string | null> {
	const header = request.headers.get('Authorization') ?? ''
	if (!header.startsWith('Bearer ')) return null
	try {
		const payload = await verify(header.slice(7), secret, 'HS256')
		return payload.sub === undefined &&
			payload.aud === 'studio-build-validation' &&
			payload.scope === 'studio.build.validate' &&
			typeof payload.buildId === 'string' &&
			/^[1-9]\d*$/.test(payload.buildId)
			? (payload.buildId as string)
			: null
	} catch {
		return null
	}
}

/**
 * Validate an HS256 token and return its `sub` (account id) claim, or `null` when
 * the token is malformed, has a bad signature, or is expired/not-yet-valid.
 * `verify` throws on all of those, so a rejection just means "no valid id".
 * Internal — callers use {@link validateAndGetAccountId}, which takes the request.
 */
async function getAccountIdFromToken(token: string, secret: string): Promise<string | null> {
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		return typeof payload.sub === 'string' ? payload.sub : null
	} catch {
		return null
	}
}

/**
 * Validate a request's auth and return the caller's integer account id, or `null`
 * when it carries no valid credential. Today that means the `sub` claim of a
 * bearer token in the `Authorization` header; taking the whole `Request` (rather
 * than a pre-extracted header) keeps that detail here, so if how we carry auth
 * changes (a cookie, a different header) callers don't. Returns `null` when there
 * is no valid bearer token, the token is invalid/expired, or `sub` isn't an integer.
 */
export async function validateAndGetAccountId(
	request: Request,
	secret: string
): Promise<number | null> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('bearer '.length)
	const accountId = await getAccountIdFromToken(token, secret)
	if (!accountId) return null

	// `parseInt("42junk", 10)` is 42, which lets a malformed subject select a real
	// account. Token subjects are canonical positive base-10 account ids: reject
	// partial parses, signs, decimals, leading zeroes and values outside JS's safe range.
	if (!/^[1-9]\d*$/.test(accountId)) return null
	const id = Number(accountId)
	return Number.isSafeInteger(id) ? id : null
}

/**
 * Validate a request's bearer token and return its `role` claim — the array of role
 * strings stamped by {@link generateToken} (e.g. `['gameClient', 'moderator']`) — or
 * `null` when the request carries no valid token (missing/malformed/expired). A valid
 * token with no `role` claim yields `[]`. Callers gate privileged actions on a specific
 * role being present; the shape mirrors {@link validateAndGetAccountId} so a handler can
 * ask for the id or the roles the same way.
 */
export async function validateAndGetRoles(
	request: Request,
	secret: string
): Promise<string[] | null> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('bearer '.length)
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		return Array.isArray(payload.role)
			? payload.role.filter((r): r is string => typeof r === 'string')
			: []
	} catch {
		return null
	}
}

/**
 * Whether a request's bearer token says the caller has Rec Room Plus — the `rn.plus`
 * claim stamped by {@link generateToken} from `account.hasPlus`. This is the ONE way Plus
 * is decided (see `econ`'s `isSubscriber`); nothing re-reads the account for it, which is
 * why a freshly-claimed player must sign in again before it applies.
 *
 * False for a missing, malformed or expired token, and false for a valid token that
 * simply carries no claim — the two are not worth telling apart, since neither is a
 * subscriber. Only a literal `true` counts, so a token carrying some other value in that
 * key can't read as Plus.
 */
export async function validateAndGetPlus(request: Request, secret: string): Promise<boolean> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return false

	const token = authHeader.slice('bearer '.length)
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		return payload['rn.plus'] === true
	} catch {
		return false
	}
}

/**
 * Validate a request's bearer token and return its `rn.ver` claim — the game build the
 * caller posted to `/connect/token`, stamped by {@link generateToken}. `null` when the
 * request carries no valid token, and `null` too when a valid token has no `rn.ver` (an
 * older token, issued before the claim carried the client's own value): callers fall back
 * to what they stored or to GAME_VERSION rather than writing an empty version, which
 * breaks the client's presence handling.
 */
export async function validateAndGetVersion(
	request: Request,
	secret: string
): Promise<string | null> {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null

	const token = authHeader.slice('bearer '.length)
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		const version = payload['rn.ver']
		return typeof version === 'string' && version !== '' ? version : null
	} catch {
		return null
	}
}

/**
 * {@link validateAndGetVersion} reduced to the BUILD it names — `gameBuild`'s bare
 * `YYYYMMDD`, so `20250718.01` and `20250718.2` both read `20250718`. `null` for the
 * same reasons as the version, and when the claim is empty. The form every build gate
 * wants: a point release is the same build and must be served the same way, so nothing
 * should compare the raw claim against a build.
 */
export async function validateAndGetBuild(
	request: Request,
	secret: string
): Promise<string | null> {
	return gameBuild(await validateAndGetVersion(request, secret))
}

/** Scopes stamped onto every token (as a claim array). */
const TOKEN_SCOPES = [
	'profile',
	'rn',
	'rn.accounts',
	'rn.accounts.gc',
	'rn.api',
	'rn.chat',
	'rn.clubs',
	'rn.commerce',
	'rn.match.read',
	'rn.match.write',
	'rn.notify',
	'rn.rooms',
	'rn.storage',
	'offline_access',
]

/**
 * Base roles every token carries — the client needs `gameClient` to operate.
 * Elevated roles (e.g. `developer`, `moderator`) are NOT baked in here; the auth
 * worker passes them per-account as `extraRoles` from the account's role flags, so
 * a plain player's token stays `['gameClient']` and only granted accounts get more.
 */
const BASE_ROLES = ['gameClient']

/**
 * The claims the Photon auth token carries beyond `sub`/`exp`/`aud`, describing who
 * (and on what) is connecting. All of them go on the wire as STRINGS, including the
 * numeric ones — that's how the real token encodes them.
 */
export interface PhotonAuthClaims {
	/** The platform-native id (e.g. a SteamID64) — `rn.platid`. */
	platformId: string
	/** PlatformType int (0 = Steam) — `rn.plat`. */
	platform: number
	/** DeviceClass int (2 = PC/standalone) — `rn.deviceclass`. */
	deviceClass: number
	/** The Photon application the token is for — the `aud` claim. */
	audience: string
}

/**
 * Mint the short-lived HS256 token the client hands to Photon as its custom auth
 * credential (`photonAuthToken` on `GET /player/connection-info`). The claim set
 * mirrors the real one — `sub`, `rn.platid`, `rn.plat`, `rn.deviceclass`, `rn.env`,
 * `exp`, `aud` — rather than being a second copy of the login token: it identifies
 * the connecting player to the realtime server and nothing else, so none of the
 * scopes or roles from {@link generateToken} belong on it.
 *
 * Signed with the same shared `JWT_SECRET` as every other token here. A real Photon
 * Cloud application would verify this against a secret configured in its dashboard;
 * self-hosted, nothing verifies it yet — so treat it as identifying, not authorizing.
 * `rn.env` is `prod` because that's what the client is built against, regardless of
 * which environment this worker is running in.
 */
export async function generatePhotonAuthToken(
	accountId: number,
	claims: PhotonAuthClaims,
	secret: string
): Promise<string> {
	return sign(
		{
			sub: String(accountId),
			'rn.platid': claims.platformId,
			'rn.plat': String(claims.platform),
			'rn.deviceclass': String(claims.deviceClass),
			'rn.env': 'prod',
			exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
			aud: claims.audience,
		},
		secret
	)
}

export async function generateToken(
	accountId: string,
	platformId: string,
	platform: number,
	secret: string,
	extraRoles: string[] = [],
	privileges: string[] = [],
	version: string = GAME_VERSION,
	hasPlus = false
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	// The client reads `role`/`scope` (and expects a well-formed iss/aud) to
	// authorize itself; a token with only `sub` is rejected before login finishes.
	return sign(
		{
			iss: 'https://auth.recflare.net',
			aud: 'https://auth.recflare.net',
			nbf: now,
			iat: now,
			exp: now + TOKEN_TTL_SECONDS,
			auth_time: now,
			amr: 'cached_login',
			client_id: 'recroom',
			sub: accountId,
			idp: 'local',
			platform,
			platform_id: platformId,
			// The CLIENT's build, as it posted it to /connect/token (`ver`) — not this
			// server's GAME_VERSION, which is only the fallback for a grant that names none
			// (a refresh, or a caller that isn't the game). Presence reads it back off the
			// token, so a player's reported version is the build they are actually running.
			'rn.ver': version,
			'rn.plat': platform,
			role: [...BASE_ROLES, ...extraRoles],
			// `rn.privilege` LOOKS like a scope but is a claim: the client reads it out of
			// the same claims dictionary it reads `role` from, and it never appears in
			// `scope`. Omitted entirely when empty, so an unrestricted token is byte-for-byte
			// what it was before privileges existed.
			...(privileges.length > 0 ? { 'rn.privilege': privileges } : {}),
			// Whether the account has Rec Room Plus (`account.hasPlus`) — a CLAIM, like
			// `rn.privilege` and for the same reason: it is ours, the client has never heard of
			// it, and `scope` is a fixed list the client parses. `econ` reads it to answer the
			// CampusCard lookup and to price the subscriber discount, which is the whole point
			// of carrying it here: those calls then need no database read at all.
			//
			// Omitted when false, so a non-subscriber's token is byte-for-byte what it was
			// before Plus existed, and `validateAndGetPlus` reads an absent claim as "no Plus".
			//
			// STAMPED AT LOGIN, so it is only as fresh as the token: a player who claims Plus on
			// the website has to sign in again (and restart the game) before it takes effect.
			// Tokens last a day and the client does not refresh them — see TOKEN_TTL_SECONDS —
			// so that wait is real, and it is the accepted trade for making the check free.
			...(hasPlus ? { 'rn.plus': true } : {}),
			scope: TOKEN_SCOPES,
			jti: crypto.randomUUID(),
		},
		secret
	)
}

/**
 * The `aud` of an identity assertion — what tells one apart from every other token this
 * key signs. An access token's audience is the auth host; a Studio build token's is
 * `studio-build-validation`. Checked on validation, so neither can be replayed as an
 * assertion, and an assertion — which carries no `sub` — satisfies none of the
 * `validateAndGet*` readers either.
 */
const IDENTITY_ASSERTION_AUDIENCE = 'recflare:identity-assertion'

/**
 * How long an assertion is good for. It is minted and redeemed within one request on the
 * server side (www proves the identity, then posts the assertion to auth), so a minute
 * covers clock skew between two Workers and nothing else.
 */
export const IDENTITY_ASSERTION_TTL_SECONDS = 60

/** A platform identity one worker has verified and is vouching for to `auth`. */
export interface IdentityAssertion {
	/** PlatformType int — Discord (101) today. */
	platform: number
	/** The platform's own id for the user — a Discord snowflake, as a string. */
	platformId: string
}

/**
 * Mint a short-lived, signed statement that the caller has VERIFIED this platform
 * identity — the credential behind `auth`'s `identity_assertion` grant.
 *
 * This exists so a worker other than `auth` can prove an identity `auth` cannot: www
 * completes a Discord OAuth2 code exchange (which needs the Discord client secret, bound
 * only to www) and hands `auth` the result, rather than `auth` learning Discord. Signing it
 * with the shared `JWT_SECRET` adds no trust that didn't exist — a holder of that key can
 * already mint access tokens outright — and it means the grant works the same over the
 * service binding and over the public hostname. The assertion names an identity, never an
 * account: resolving it to one (or minting one) stays `auth`'s decision.
 */
export async function generateIdentityAssertion(
	identity: IdentityAssertion,
	secret: string
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	return sign(
		{
			aud: IDENTITY_ASSERTION_AUDIENCE,
			platform: identity.platform,
			platform_id: identity.platformId,
			iat: now,
			nbf: now,
			exp: now + IDENTITY_ASSERTION_TTL_SECONDS,
			jti: crypto.randomUUID(),
		},
		secret,
		'HS256'
	)
}

/**
 * Validate an identity assertion and return the identity it vouches for, or null when
 * the token is malformed, mis-signed, expired, or not an assertion at all. The audience
 * check is what refuses an access token presented here, and a missing `sub` is required
 * for the same reason in the other direction: an assertion must never pass as a session.
 */
export async function validateIdentityAssertion(
	token: string,
	secret: string
): Promise<IdentityAssertion | null> {
	try {
		const payload = await verify(token, secret, 'HS256') // checks exp/nbf/signature
		if (payload.aud !== IDENTITY_ASSERTION_AUDIENCE || payload.sub !== undefined) return null
		const platform = payload.platform
		const platformId = payload.platform_id
		if (typeof platform !== 'number' || !Number.isInteger(platform) || platform < 0) return null
		if (typeof platformId !== 'string' || platformId === '') return null
		return { platform, platformId }
	} catch {
		return null
	}
}
