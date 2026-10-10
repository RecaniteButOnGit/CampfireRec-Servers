import {
	getAccount,
	getAccountByUsername,
	listStudioAccounts,
	updateAccount,
	writeAuditLog,
} from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { Context } from 'hono'
import type { Account } from '@repo/domain'
import type { App } from './context'

/**
 * Studio upload access, as the website manages it.
 *
 * RecFlare Studio opens `/settings/recroomstudio` from the dialog that says the
 * account cannot upload. That page reads {@link studioAccessStatusHandler} for
 * the signed-in player. Staff add and remove people through the routes under
 * `/api/staff/studio-access`, behind the same `requireStaff` gate as moderation.
 * The grant is the account's `hasStudio` flag; `auth` stamps `betastudio` from it
 * on the next Studio sign-in or refresh. Who granted what is on `audit_log`.
 */

/** The signed-in player's own flag, and nothing else. 401 with no session. */
export async function studioAccessStatusHandler(c: Context<App>) {
	const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (accountId === null) return c.json({ error: 'Unauthorized' }, 401)
	const account = await getAccount(c.env.DB, accountId)
	return c.json({ granted: account?.hasStudio === true })
}

/** Every account with the flag set. */
export async function listStudioAccessHandler(c: Context<App>) {
	const accounts = await listStudioAccounts(c.env.DB)
	return c.json({
		accounts: accounts.map((account) => ({
			accountId: account.accountId,
			username: account.username,
			displayName: account.displayName,
		})),
	})
}

/**
 * Add a player, by username or account id. Unknown players are a 404 rather than
 * a flag on an account that doesn't exist. A player who already has it keeps it,
 * and the reply says so.
 */
export async function grantStudioAccessHandler(c: Context<App>) {
	const body = await c.req.json().catch(() => null)
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'Expected a JSON body' }, 400)
	}
	const posted = body as { username?: unknown; accountId?: unknown }
	const username =
		typeof posted.username === 'string' ? posted.username.trim().replace(/^@/, '') : ''
	const accountId = postedAccountId(posted.accountId)

	let account: Account | null = null
	if (username !== '') {
		account = await getAccountByUsername(c.env.DB, username)
		if (!account) return c.json({ error: `No player is called @${username}` }, 404)
		if (accountId !== null && accountId !== account.accountId) {
			return c.json({ error: 'That username and account id are different players' }, 400)
		}
	} else if (accountId !== null) {
		account = await getAccount(c.env.DB, accountId)
		if (!account) return c.json({ error: 'No player has that account id' }, 404)
	} else {
		return c.json({ error: 'Name a player by username or account id' }, 400)
	}

	const alreadyGranted = account.hasStudio === true
	if (!alreadyGranted) await updateAccount(c.env.DB, account.accountId, { hasStudio: true })
	await recordAudit(c, 'grant_studio_access', {
		playerId: account.accountId,
		username: account.username,
		alreadyGranted,
	})
	return c.json({
		accountId: account.accountId,
		username: account.username,
		granted: true,
		alreadyGranted,
	})
}

/**
 * Take a player off the list. A player who did not have it answers 200 with
 * `removed: false`, so a double click is not an error. An id that names no
 * account is a 404.
 */
export async function revokeStudioAccessHandler(c: Context<App>) {
	const accountId = Number(c.req.param('id'))
	if (!Number.isInteger(accountId) || accountId <= 0) {
		return c.json({ error: 'A numeric player id is required' }, 400)
	}
	const account = await getAccount(c.env.DB, accountId)
	if (!account) return c.json({ error: 'No player has that account id' }, 404)
	const removed = account.hasStudio === true
	if (removed) await updateAccount(c.env.DB, accountId, { hasStudio: false })
	await recordAudit(c, 'revoke_studio_access', {
		playerId: accountId,
		username: account.username,
		removed,
	})
	return c.json({ accountId, granted: false, removed })
}

/** A positive integer account id from a JSON field, or null when it isn't one. */
function postedAccountId(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
	if (typeof value === 'string' && /^\d+$/.test(value)) {
		const parsed = Number.parseInt(value, 10)
		return parsed > 0 ? parsed : null
	}
	return null
}

/**
 * Record a change on `audit_log`. Written after the change has committed and
 * never throws: the flag has already changed, and a failed insert must not tell
 * the moderator it didn't.
 */
async function recordAudit(
	c: Context<App>,
	action: string,
	data: Record<string, unknown>
): Promise<void> {
	try {
		await writeAuditLog(c.env.DB, { playerId: c.get('staffId'), action, data })
	} catch (err) {
		logger.error('could not write an audit log row', {
			action,
			moderatorId: c.get('staffId'),
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
