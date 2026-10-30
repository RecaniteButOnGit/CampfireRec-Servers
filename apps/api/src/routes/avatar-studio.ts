import { Hono } from 'hono'

import {
	AVATAR_STUDIO_SLOTS,
	avatarItemAccessBit,
	avatarSaveDto,
	avatarStudioFlags,
	avatarStudioItem,
	avatarStudioSave,
	canManageRoomById,
	publishAvatarSave,
} from '@repo/domain'

import { parseMultipart } from '../../../studio/src/multipart'
import { getCustomAvatarItem, toQuestCustomAvatarItem } from '../custom-avatar-items-db'
import { authedId, authedRoles } from '../http'

import type { Context } from 'hono'
import type { AvatarStudioSave } from '@repo/domain'
import type { App } from '../context'

const uuid = '[0-9a-fA-F-]{36}'
const ok = (value: unknown) => ({ success: true, error: null, value })
const fail = (error: string) => ({ success: false, error, value: null })
const slots = new Set(AVATAR_STUDIO_SLOTS)
function validTags(value: unknown): boolean {
	return (
		value == null ||
		(Array.isArray(value) &&
			value.length <= 64 &&
			value.every(
				(t) =>
					t &&
					Number.isInteger(t.TagType) &&
					t.TagType >= 0 &&
					t.TagType <= 255 &&
					typeof t.Value === 'string' &&
					t.Value.length > 0 &&
					t.Value.length <= 64
			))
	)
}
async function allowed(c: Context<App>, accountId: number, slot: number) {
	const roles = await authedRoles(c)
	return (
		roles?.includes('betastudio') &&
		(![104, 203].includes(slot) || roles.includes('developer')) &&
		((await avatarStudioFlags(c.env.DB, accountId)) & avatarItemAccessBit(slot)) !== 0
	)
}
const safeName = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[a-zA-Z0-9_./-]+$/.test(value) &&
	!value.split('/').some((p) => p === '..' || p === '.' || p === '')

export const avatarStudioRoutes = new Hono<App>()
	.get('/api/customAvatarItems/v1/me', async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const rows = await c.env.DB.prepare(
			'SELECT data FROM custom_avatar_item WHERE creator_account_id=? ORDER BY created_at DESC,custom_avatar_item_id'
		)
			.bind(id)
			.all<{ data: string }>()
		const all = rows.results.map((r) => JSON.parse(r.data))
		const skip = Math.max(0, Number(c.req.query('skip')) || 0),
			take = Math.min(10000, Math.max(1, Number(c.req.query('take')) || 100))
		return c.json({ Results: all.slice(skip, skip + take), TotalResults: all.length })
	})
	.get(`/api/customAvatarItems/v1/:id{${uuid}}`, async (c) => {
		const item = await getCustomAvatarItem(c.env.DB, c.req.param('id'))
		if (!item) return c.notFound()
		if (item.Accessibility === 0 && item.CreatorAccountId !== (await authedId(c)))
			return c.body(null, 403)
		return c.json(c.req.query('unityAssetTarget') === '2' ? toQuestCustomAvatarItem(item) : item)
	})
	.post('/api/customAvatarItems/v1', async (c, next) => {
		// Preserve the existing in-game custom-shirt contract, including its errors.
		const form = await parseMultipart(c.req.raw.clone())
		let body: Record<string, unknown>
		try {
			body = JSON.parse(String(form.metadata))
		} catch {
			return next()
		}
		if (
			!body ||
			typeof body !== 'object' ||
			body.BaseAvatarItemId !== undefined ||
			form.design ||
			form.thumbnailImage
		)
			return next()
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const slot = Number(body.OutfitType)
		if (!Number.isInteger(slot) || !slots.has(slot))
			return c.json(fail('Unsupported avatar item type.'), 400)
		if (!(await allowed(c, id, slot)))
			return c.json(fail('Avatar Studio authorization is required.'), 403)
		const badgeRoomId = Number(body.BadgeRoomId ?? 0)
		if (
			slot === 1000 &&
			(!Number.isSafeInteger(badgeRoomId) ||
				badgeRoomId < 0 ||
				(badgeRoomId > 0 && !(await canManageRoomById(c.env.DB, badgeRoomId, id))))
		)
			return c.json(fail('Badge room is not managed by this account.'), 403)
		if (
			typeof body.Name !== 'string' ||
			!body.Name.trim() ||
			body.Name.length > 128 ||
			(body.Description != null &&
				(typeof body.Description !== 'string' || body.Description.length > 4000))
		)
			return c.json(fail('Invalid item name or description.'), 400)
		if (
			body.Price !== undefined &&
			body.Price !== null &&
			(!Number.isInteger(body.Price) || Number(body.Price) < 0 || Number(body.Price) > 1000)
		)
			return c.json(fail('Invalid item price.'), 400)
		if (body.Accessibility !== undefined && ![0, 1, 2].includes(Number(body.Accessibility)))
			return c.json(fail('Invalid accessibility.'), 400)
		if (body.Accessibility && body.Accessibility !== 0)
			return c.json(fail('Create the item privately and publish a built save first.'), 400)
		if (!validTags(body.Tags)) return c.json(fail('Invalid avatar tags.'), 400)
		const now = new Date().toISOString(),
			itemId = crypto.randomUUID()
		const item = {
			CustomAvatarItemId: itemId,
			CreatorAccountId: id,
			Name: body.Name.trim(),
			Description: body.Description ?? '',
			Price: body.Price ?? 0,
			Accessibility: body.Accessibility ?? 0,
			ForceCannotPublish: false,
			IsFeatured: false,
			IsRecRoomApproved: false,
			BaseAvatarItemId: null,
			BaseAvatarItemColor: null,
			DesignFilename: null,
			ThumbnailImageFilename: null,
			CreatedAt: now,
			ModifiedAt: now,
			PreviewOrientation: body.PreviewOrientation ?? 0,
			RankingContext: null,
			OutfitType: slot,
			CurrentSaves: [],
			Tags: body.Tags ?? [],
			IsStudioAuthored: true,
			CustomBadgeMetadata: slot === 1000 ? { RoomId: badgeRoomId } : null,
			RankedEntityId: itemId,
			PurchaseInfo: null,
		}
		await c.env.DB.prepare('INSERT INTO custom_avatar_item(data) VALUES (?)')
			.bind(JSON.stringify(item))
			.run()
		return c.json(ok(item))
	})
	.put(`/api/customAvatarItems/v1/:id{${uuid}}`, async (c, next) => {
		const itemId = c.req.param('id')
		const existing = await avatarStudioItem(c.env.DB, itemId)
		if (!existing?.IsStudioAuthored) return next()
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		if (existing.CreatorAccountId !== id || !(await allowed(c, id, existing.OutfitType)))
			return c.body(null, 403)
		const body = await c.req.json<Record<string, unknown>>().catch(() => null)
		if (
			!body ||
			(body.Name != null &&
				(typeof body.Name !== 'string' || !body.Name.trim() || body.Name.length > 128)) ||
			(body.Description != null &&
				(typeof body.Description !== 'string' || body.Description.length > 4000)) ||
			(body.Price != null &&
				(!Number.isInteger(body.Price) || Number(body.Price) < 0 || Number(body.Price) > 1000)) ||
			(body.Accessibility != null && ![0, 1, 2].includes(Number(body.Accessibility))) ||
			!validTags(body.Tags)
		)
			return c.json(fail('Invalid avatar metadata.'), 400)
		for (let attempt = 0; attempt < 5; attempt++) {
			const item = await avatarStudioItem(c.env.DB, itemId)
			if (!item) return c.notFound()
			if (body.Accessibility && !item.CurrentSaves?.length)
				return c.json(fail('Publish a built save before making the item public.'), 400)
			const prior = JSON.stringify(item)
			for (const key of ['Name', 'Description', 'Price', 'Accessibility', 'Tags'])
				if (body[key] != null) item[key] = key === 'Name' ? String(body[key]).trim() : body[key]
			item.ModifiedAt = new Date().toISOString()
			const result = await c.env.DB.prepare(
				'UPDATE custom_avatar_item SET data=? WHERE custom_avatar_item_id=? AND json(data)=json(?)'
			)
				.bind(JSON.stringify(item), itemId, prior)
				.run()
			if (result.meta.changes) return c.json(ok(item))
		}
		return c.json(fail('The item changed concurrently. Retry the edit.'), 409)
	})
	.get(`/api/customAvatarItems/:id{${uuid}}/saves`, async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const itemId = c.req.param('id'),
			item = await avatarStudioItem(c.env.DB, itemId)
		if (!item) return c.notFound()
		if (item.CreatorAccountId !== id) return c.body(null, 403)
		const rows = await c.env.DB.prepare(
			'SELECT * FROM avatar_studio_save WHERE item_id=? ORDER BY id DESC'
		)
			.bind(itemId)
			.all<AvatarStudioSave>()
		const skip = Math.max(0, Number(c.req.query('skip')) || 0),
			take = Math.min(10000, Math.max(1, Number(c.req.query('take')) || 100))
		return c.json(
			ok({
				Results: await Promise.all(
					rows.results.slice(skip, skip + take).map((r) => avatarSaveDto(c.env.DB, r))
				),
				TotalResults: rows.results.length,
			})
		)
	})
	.post(`/api/customAvatarItems/:id{${uuid}}/saves`, async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const itemId = c.req.param('id'),
			item = await avatarStudioItem(c.env.DB, itemId)
		if (!item) return c.notFound()
		if (item.CreatorAccountId !== id || !(await allowed(c, id, item.OutfitType)))
			return c.body(null, 403)
		const body = await c.req.json<Record<string, unknown>>().catch(() => null)
		if (
			!body ||
			!Number.isInteger(body.BodyType) ||
			![0, 1, 2, 3, 4].includes(Number(body.BodyType)) ||
			!safeName(body.ThumbnailFileName) ||
			typeof body.AdditionalConfiguration !== 'string' ||
			body.AdditionalConfiguration.length > 1024 * 1024 ||
			(body.SaveDescription != null &&
				(typeof body.SaveDescription !== 'string' || body.SaveDescription.length > 4000))
		)
			return c.json(fail('Invalid avatar save.'), 400)
		try {
			JSON.parse(body.AdditionalConfiguration)
		} catch {
			return c.json(fail('Invalid additional configuration JSON.'), 400)
		}
		let filename: string, hash: string, unityId: string
		if (body.NewUnityAssetFile && typeof body.NewUnityAssetFile === 'object') {
			const file = body.NewUnityAssetFile as Record<string, unknown>
			if (!safeName(file.Filename)) return c.json(fail('Invalid source filename.'), 400)
			const object = await c.env.CDN_ASSETS.head('avatarunityasset/' + file.Filename)
			if (!object || object.customMetadata?.ownerId !== String(id))
				return c.json(fail('Source upload does not belong to this account.'), 403)
			const checksum = object.checksums.sha256
			hash = checksum ? btoa(String.fromCharCode(...new Uint8Array(checksum))) : ''
			if (!hash || file.Hash !== hash)
				return c.json(fail('Source hash does not match uploaded bytes.'), 400)
			filename = file.Filename
			unityId = crypto.randomUUID()
		} else if (typeof body.ExistingUnityAssetId === 'string') {
			const prior = await c.env.DB.prepare(
				'SELECT * FROM avatar_studio_save WHERE item_id=? AND unity_asset_id=? ORDER BY id DESC LIMIT 1'
			)
				.bind(itemId, body.ExistingUnityAssetId)
				.first<AvatarStudioSave>()
			if (!prior) return c.json(fail('No matching source revision on this item.'), 400)
			filename = prior.source_filename
			hash = prior.source_hash
			// A source can be reused across builds, but compiled outputs belong to
			// one body/configuration. Only metadata-only revisions share their output.
			unityId =
				prior.body_type === body.BodyType && prior.configuration === body.AdditionalConfiguration
					? prior.unity_asset_id
					: crypto.randomUUID()
		} else return c.json(fail('A new or existing source asset is required.'), 400)
		if (item.OutfitType === 1000) {
			const config = JSON.parse(body.AdditionalConfiguration as string)
			const badgeRoom = config?.d?.d?.r ?? 0
			if (
				config?.v !== 1 ||
				config?.d?.o !== 1000 ||
				!Number.isSafeInteger(badgeRoom) ||
				badgeRoom < 0
			)
				return c.json(fail('Invalid badge configuration.'), 400)
			if (badgeRoom > 0 && !(await canManageRoomById(c.env.DB, badgeRoom, id)))
				return c.json(fail('Badge room is not managed by this account.'), 403)
			if (body.BodyType !== 4)
				return c.json(fail('Badge images require the body-agnostic body type.'), 400)
			const source = await c.env.CDN_ASSETS.get('avatarunityasset/' + filename)
			if (!source || source.size > 8 * 1024 * 1024)
				return c.json(fail('Missing or oversized badge source.'), 400)
			const manifest = await source
				.json<{
					Version: number
					MainAssetProjectRelativePath: string
					Files: Array<{ p: string; n: string }>
				}>()
				.catch(() => null)
			if (
				!manifest ||
				manifest.Version !== 3 ||
				!Array.isArray(manifest.Files) ||
				!manifest.Files.length ||
				manifest.Files.length > 100000 ||
				!safeName(manifest.MainAssetProjectRelativePath) ||
				!manifest.MainAssetProjectRelativePath.startsWith('Assets/') ||
				!/\.(png|jpe?g)$/i.test(manifest.MainAssetProjectRelativePath) ||
				manifest.Files.some(
					(f) =>
						!f ||
						!safeName(f.p) ||
						!/^(Assets|Packages)\//.test(f.p) ||
						/\.(cs|dll|exe|so|dylib|rsp|asmdef|asmref)$/i.test(f.p) ||
						!/^[a-z0-9]{40}$/.test(f.n)
				) ||
				new Set(manifest.Files.map((f) => f.p.toLowerCase())).size !== manifest.Files.length
			)
				return c.json(fail('Invalid badge image source manifest.'), 400)
			const main = manifest.Files.find((f) => f.p === manifest.MainAssetProjectRelativePath)
			const image = main ? await c.env.CDN_ASSETS.get('unityasset/' + main.n) : null
			if (!image || image.size > 16 * 1024 * 1024)
				return c.json(fail('Badge source image is missing or oversized.'), 400)
			const signature = new Uint8Array(await image.arrayBuffer()).subarray(0, 8)
			if (
				!(
					signature[0] === 137 &&
					signature[1] === 80 &&
					signature[2] === 78 &&
					signature[3] === 71
				) &&
				!(signature[0] === 255 && signature[1] === 216 && signature[2] === 255)
			)
				return c.json(fail('Badge source must be a PNG or JPEG image.'), 400)
		}
		for (const name of [body.ThumbnailFileName, body.ModerationImageFileName].filter(
			(v) => v !== undefined && v !== null
		)) {
			if (!safeName(name)) return c.json(fail('Invalid image filename.'), 400)
			const image = await c.env.CDN_ASSETS.get('image/' + name)
			if (!image || image.customMetadata?.ownerId !== String(id))
				return c.json(fail('Image upload does not belong to this account.'), 403)
			if (image.size > 16 * 1024 * 1024) return c.json(fail('Avatar image exceeds limit.'), 413)
			// Storage's image upload and the Images service use different buckets.
			// Keep the SDK filename unchanged when publishing creator-owned thumbnails.
			await c.env.IMAGES.put(name, image.body, { httpMetadata: image.httpMetadata })
		}
		const row = await c.env.DB.prepare(
			'INSERT INTO avatar_studio_save(item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,moderation_image,configuration,description,update_current,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id'
		)
			.bind(
				itemId,
				body.BodyType,
				unityId,
				filename,
				hash,
				body.ThumbnailFileName,
				typeof body.ModerationImageFileName === 'string' ? body.ModerationImageFileName : null,
				body.AdditionalConfiguration,
				body.SaveDescription ?? null,
				body.UpdateCurrentSaveIfPrivate === true ? 1 : 0,
				new Date().toISOString()
			)
			.first<{ id: number }>()
		if (body.UpdateCurrentSaveIfPrivate === true && item.Accessibility === 0)
			await publishAvatarSave(c.env.DB, itemId, row!.id, true)
		return c.json(ok(row!.id))
	})
	.post(`/api/customAvatarItems/:id{${uuid}}/saves/:saveId{[1-9][0-9]*}/publish`, async (c) => {
		const id = await authedId(c)
		if (id === null) return c.body(null, 401)
		const item = await avatarStudioItem(c.env.DB, c.req.param('id'))
		if (!item) return c.notFound()
		if (item.CreatorAccountId !== id || !(await allowed(c, id, item.OutfitType)))
			return c.body(null, 403)
		const save = await avatarStudioSave(
			c.env.DB,
			item.CustomAvatarItemId,
			Number(c.req.param('saveId'))
		)
		if (item.OutfitType === 1000 && save) {
			const badgeRoom = JSON.parse(save.configuration)?.d?.d?.r ?? 0
			if (badgeRoom > 0 && !(await canManageRoomById(c.env.DB, badgeRoom, id)))
				return c.body(null, 403)
		}
		if (!save || !(await publishAvatarSave(c.env.DB, item.CustomAvatarItemId, save.id)))
			return c.json(fail('Save has not completed a build.'), 400)
		return c.json(ok(null))
	})
