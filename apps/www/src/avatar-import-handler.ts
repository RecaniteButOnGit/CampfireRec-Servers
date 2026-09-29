import { getAccount, writeAuditLog } from '@repo/domain'
import { logger } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import { convertAvatarData, readAvatarUpload } from './avatar-import'

import type { Context } from 'hono'
import type { App } from './context'

/** Account 2 is the sole operator authorized by the owner for avatar imports. */
const AVATAR_IMPORTER_ACCOUNT_ID = 2

export async function importAvatarHandler(c: Context<App>) {
	const actorId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
	if (actorId === null) return c.json({ error: 'Unauthorized' }, 401)
	if (actorId !== AVATAR_IMPORTER_ACCOUNT_ID) return c.json({ error: 'Forbidden' }, 403)

	const rawId = c.req.param('id')
	const playerId = Number(rawId)
	if (!rawId || !/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(playerId))
		return c.json({ error: 'A numeric player id is required' }, 400)
	if (!(await getAccount(c.env.DB, playerId))) return c.json({ error: 'No such player' }, 404)

	const length = Number(c.req.header('content-length'))
	if (Number.isFinite(length) && length > 9 * 1024 * 1024)
		return c.json({ error: 'The upload is too large (maximum 8 MiB).' }, 413)

	let avatar: ReturnType<typeof convertAvatarData>
	try {
		const form = await c.req.raw.formData()
		const upload = form.get('file')
		if (!(upload instanceof File))
			return c.json({ error: 'Choose AvatarData.binpb or a ZIP containing it.' }, 400)
		avatar = convertAvatarData(await readAvatarUpload(upload))
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : 'Invalid avatar upload.' }, 400)
	}

	// Slot 0 is what the newer client wears. Positive slots are wardrobe saves. An
	// INSERT without an update arm makes concurrent imports retry rather than overwrite.
	let savedSlot: number | undefined
	for (let attempt = 0; attempt < 5; attempt++) {
		const { results } = await c.env.DB.prepare(
			'SELECT set_id FROM outfit WHERE account_id = ?1 AND set_id > 0 ORDER BY set_id'
		)
			.bind(playerId)
			.all<{ set_id: number }>()
		const occupied = new Set(results.map((row) => row.set_id))
		let slot = 1
		while (occupied.has(slot)) slot++
		try {
			await c.env.DB.batch([
				c.env.DB.prepare(
					'INSERT INTO outfit (account_id, set_id, avatar) VALUES (?1, ?2, ?3)'
				).bind(playerId, slot, JSON.stringify({ ...avatar.saved, Slot: slot })),
				c.env.DB.prepare('UPDATE account SET avatar = ?2 WHERE account_id = ?1').bind(
					playerId,
					JSON.stringify(avatar.avatar)
				),
				c.env.DB.prepare(
					'INSERT INTO outfit (account_id, set_id, avatar) VALUES (?1, 0, ?2) ON CONFLICT (account_id, set_id) DO UPDATE SET avatar = ?2'
				).bind(playerId, JSON.stringify(avatar.worn)),
			])
			savedSlot = slot
			break
		} catch (error) {
			if (!/unique|constraint|primary key/i.test(String(error))) throw error
		}
	}
	if (savedSlot === undefined)
		return c.json({ error: 'Could not find a free outfit slot. Please try again.' }, 409)

	try {
		await writeAuditLog(c.env.DB, {
			playerId: actorId,
			action: 'import_avatar',
			data: { playerId, savedSlot },
		})
	} catch (error) {
		logger.error('could not audit avatar import', {
			playerId,
			actorId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
	return c.json({ playerId, savedSlot })
}
