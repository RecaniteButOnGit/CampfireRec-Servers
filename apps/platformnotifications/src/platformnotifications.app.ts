import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { App } from './context'

/**
 * Resolve the account id from a Bearer token. Returns `null` when the header is missing,
 * the token is invalid, or the `sub` claim isn't an integer.
 */
async function authedId(c: Context<App>): Promise<number | null> {
	return validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
}

/** Results.Unauthorized() equivalent — 401 with empty body. */
function unauthorized(c: Context<App>) {
	return c.body(null, 401)
}

/**
 * The notification categories `GET /config/categories` serves as its `Results` — a STUB
 * standing in for the real list until something here actually defines categories and stores
 * preferences against them.
 *
 * `CategoryId` is the client's own id for the category, `Importance` its ranking (0 being
 * the lowest observed), and `IsMuteable` whether the player may switch it off at all. The
 * stub marker lives in `Description` because that is what the client displays; keep it
 * there — a category that silently does nothing is worse than one that says it does nothing.
 */
const NOTIFICATION_CATEGORIES = [
	{
		CategoryId: 2,
		Importance: 0,
		Name: 'Friends',
		Description: 'Friend requests and friend activity [STUB — recflare sends no notifications yet]',
		IsMuteable: true,
	},
]

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

	.get('/', async (c) => {
		return c.text('hello, world!')
	})

	// Whether a player receives gameplay invites — the switch the client checks before
	// offering to invite someone. Always true: nothing here stores per-player notification
	// preferences, and true is the answer that leaves inviting working. A bare JSON boolean,
	// not an envelope.
	//
	// `{id}` is the account being asked about and is accepted but not read: the answer is the
	// same for everyone, so there is nothing to look up. The token is still validated first,
	// as the reference does, which means a caller can ask about any id but must be someone.
	.get('/accounts/:id{[0-9]+}/receives/GameplayInvites', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		return c.json(true)
	})

	// The notification categories a player can be shown toggles for — the "what may we notify
	// you about" list. A `{ Results, TotalResults }` PAGE of PascalCase categories, the same
	// envelope the other paged reads on this server use — not the bare array this once
	// served. No auth: the list is server-side config, the same for every player, and a
	// caller's own preferences are the per-account routes above.
	//
	// `TotalResults` counts the whole list rather than the page, and there is only ever one
	// page here — nothing pages a list this short — so it is the array's own length. Counting
	// it rather than writing the number keeps the two from disagreeing when a category is
	// added.
	//
	// STUB. Nothing here defines categories or stores a preference against one, so this is
	// one hand-written entry standing in for the real list — the toggle it draws does
	// nothing. The `Description` says so IN THE TEXT rather than only in this comment: it is
	// the field the client renders, so the stub is visible in-game instead of looking like
	// a real (and broken) setting. `Name` is left clean in case the client keys off it.
	.get('/config/categories', async (c) => {
		return c.json({
			Results: NOTIFICATION_CATEGORIES,
			TotalResults: NOTIFICATION_CATEGORIES.length,
		})
	})

	// The caller's CRM configuration — which CRM (Braze, Rengage) and push service the
	// client is assigned, fetched on startup before it will ask about anything else here.
	//
	// ENVELOPED: the client decodes a `RecNetResultObject<CrmAssignmentDTO>` and reads
	// `Value` off it itself, so the `{ Value, Success, Error, error_id }` wrapper is on the
	// wire — this once served a bare `{}`, which leaves `Value` null. Note the casing:
	// PascalCase `Success`/`Error` beside a snake_case `error_id`.
	//
	// `Value` has exactly two keys. `UserConfig.AssignedCrmType` is the `CrmType` enum (None
	// 0, Braze 1, Rengage 2) and `AllowPush` a bool — both NON-nullable on the client, so
	// never null. `AssignedPushNotificationService` is a nullable `PushNotificationServices`
	// (APNS 0, Firebase 1, Mock 2, Braze 3, Rengage 4). `BrazeConfig` is `{ AppId,
	// SdkEndpoint }` or null.
	//
	// STUB: there is no CRM behind this, so the answer is "none assigned" — type 0, no push
	// service, push off, no Braze config — rather than an invented assignment that would
	// switch on messaging paths with nothing to serve them. Nothing here is rendered, so
	// the stub marker stays in this comment.
	//
	// Auth-gated because the route is `me`-scoped, like `/preferences` below: the config
	// belongs to the caller even while the answer is the same for everyone.
	.get('/crm/me/config/v3', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		return c.json({
			Value: {
				UserConfig: {
					AssignedCrmType: 0,
					AssignedPushNotificationService: null,
					AllowPush: false,
				},
				BrazeConfig: null,
			},
			Success: true,
			Error: null,
			error_id: null,
		})
	})

	// The caller's own notification preferences — which categories they have muted, by
	// CategoryId (the ids `/config/categories` above hands out).
	//
	// STUB: nothing here stores a preference, so nobody has muted anything and the list is
	// empty. Empty is also the right stub value rather than a made-up id: a muted category
	// the player never muted would show as an off switch they can't explain, and the ids
	// would have to agree with the category list to mean anything at all.
	//
	// Auth-gated — this one IS per-player, unlike the category config above. A `{ }` object
	// rather than a bare array: the shape has room for the other preferences the reference
	// carries here.
	.get('/preferences', async (c) => {
		const accountId = await authedId(c)
		if (accountId === null) return unauthorized(c)

		return c.json({ MutedCategories: [] })
	})

export default app
