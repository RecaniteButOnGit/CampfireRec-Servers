import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'

import {
	AVATAR_STUDIO_SCHEMA,
	avatarSaveDto,
	avatarStudioSave,
	publishAvatarSave,
	ROOM_SCHEMA_DDL,
	UNITY_ASSET_SCHEMA_DDL,
} from '@repo/domain'
import { generateToken } from '@repo/jwt'

import { SCHEMA_DDL } from '../../custom-avatar-items-db'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
const base = 'https://example.com/api/customAvatarItems'
async function headers(id = 42, roles = ['betastudio']) {
	return {
		Authorization: 'Bearer ' + (await generateToken(String(id), 'fixture', 0, 'test-key', roles)),
	}
}
beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('test-key')
	for (const sql of [
		...SCHEMA_DDL,
		...AVATAR_STUDIO_SCHEMA,
		...UNITY_ASSET_SCHEMA_DDL,
		...ROOM_SCHEMA_DDL,
	])
		await env.DB.prepare(sql).run()
	await env.DB.prepare("INSERT INTO avatar_studio_access VALUES (42,1,'now','now')").run()
})
beforeEach(async () => {
	await env.DB.prepare('DELETE FROM avatar_studio_save').run()
	await env.DB.prepare('DELETE FROM custom_avatar_item').run()
	await env.DB.prepare('UPDATE avatar_studio_access SET flags=1 WHERE account_id=42').run()
})
it('saves and publishes image badges directly, while enforcing badge grants and room ownership', async () => {
	expect((await create(42, ['betastudio'], 1000)).status).toBe(403)
	await env.DB.prepare('UPDATE avatar_studio_access SET flags=5 WHERE account_id=42').run()
	const foreign = new FormData()
	foreign.set(
		'metadata',
		JSON.stringify({ Name: 'Foreign badge', OutfitType: 1000, BadgeRoomId: 98765 })
	)
	expect(
		(await SELF.fetch(base + '/v1', { method: 'POST', headers: await headers(), body: foreign }))
			.status
	).toBe(403)
	const { value: item } = await (
		await create(42, ['betastudio'], 1000)
	).json<{ value: { CustomAvatarItemId: string } }>()
	const png = Uint8Array.from(
		atob(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
		),
		(c) => c.charCodeAt(0)
	)
	const main = 'b'.repeat(40)
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			Version: 3,
			MainAssetProjectRelativePath: 'Assets/Badge.png',
			Files: [{ n: main, p: 'Assets/Badge.png' }],
		})
	)
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	await env.CDN_ASSETS.put('avatarunityasset/badge-source', bytes, {
		sha256: digest,
		customMetadata: { ownerId: '42' },
	})
	await env.CDN_ASSETS.put('unityasset/' + main, png)
	await env.CDN_ASSETS.put('image/badge.png', png, {
		customMetadata: { ownerId: '42' },
		httpMetadata: { contentType: 'image/png' },
	})
	const url = base + '/' + item.CustomAvatarItemId + '/saves'
	const save = await SELF.fetch(url, {
		method: 'POST',
		headers: { ...(await headers()), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			NewUnityAssetFile: {
				Filename: 'badge-source',
				Hash: btoa(String.fromCharCode(...new Uint8Array(digest))),
			},
			BodyType: 4,
			ThumbnailFileName: 'badge.png',
			AdditionalConfiguration: JSON.stringify({
				v: 1,
				d: { n: 'Badge', o: 1000, d: { t: '000000' } },
			}),
			UpdateCurrentSaveIfPrivate: true,
		}),
	})
	expect(save.status).toBe(200)
	const { value: saveId } = await save.json<{ value: number }>()
	const detail = await SELF.fetch(base + '/v1/' + item.CustomAvatarItemId, {
		headers: await headers(),
	})
	expect(await detail.json()).toMatchObject({
		ThumbnailImageFilename: 'badge.png',
		CurrentSaves: [{ CustomAvatarItemSaveId: saveId, BodyType: 4, UnityAsset: null }],
	})
	expect(
		(
			await SELF.fetch(url + '/' + saveId + '/publish', {
				method: 'POST',
				headers: await headers(),
			})
		).status
	).toBe(200)
	expect(await (await env.IMAGES.get('badge.png'))!.arrayBuffer()).toEqual(png.buffer)
	const published = await SELF.fetch(base + '/v1/' + item.CustomAvatarItemId, {
		method: 'PUT',
		headers: { ...(await headers()), 'Content-Type': 'application/json' },
		body: JSON.stringify({ Accessibility: 1 }),
	})
	expect(published.status).toBe(200)
	expect((await SELF.fetch(base + '/v1/' + item.CustomAvatarItemId)).status).toBe(200)
})
async function create(id = 42, roles = ['betastudio'], outfitType = 0) {
	const form = new FormData()
	form.set(
		'metadata',
		JSON.stringify({ Name: 'Studio Hat', OutfitType: outfitType, Accessibility: 0, Price: 0 })
	)
	return SELF.fetch(base + '/v1', { method: 'POST', headers: await headers(id, roles), body: form })
}
it('accepts the SDK create request with nullable metadata fields', async () => {
	const form = new FormData()
	form.set(
		'metadata',
		JSON.stringify({
			Name: 'SDK item',
			OutfitType: 101,
			BaseAvatarItemColor: '#101',
			BadgeRoomId: null,
			PreviewOrientation: null,
			Description: null,
			Tags: null,
			Price: null,
			Accessibility: null,
		})
	)
	const response = await SELF.fetch(base + '/v1', {
		method: 'POST',
		headers: await headers(),
		body: form,
	})
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		value: { Description: '', Tags: [], Price: 0, Accessibility: 0, CurrentSaves: [] },
	})
})
it('keeps grants per-account, rejects forbidden item categories, and creates metadata-only Studio items', async () => {
	expect((await create(43)).status).toBe(403)
	expect((await create(42, [])).status).toBe(403)
	expect((await create(42, ['betastudio'], 500)).status).toBe(403)
	const response = await create()
	expect(response.status).toBe(200)
	const { value: item } = await response.json<{
		value: { CustomAvatarItemId: string; OutfitType: number; CurrentSaves: unknown[] }
	}>()
	expect(item.OutfitType).toBe(0)
	expect(item.CurrentSaves).toEqual([])
	expect((await SELF.fetch(base + '/v1/' + item.CustomAvatarItemId)).status).toBe(403)
	expect(
		(await SELF.fetch(base + '/v1/' + item.CustomAvatarItemId, { headers: await headers() })).status
	).toBe(200)
	const page = await SELF.fetch(base + '/v1/me', { headers: await headers() })
	expect(await page.json()).toMatchObject({
		TotalResults: 1,
		Results: [{ CustomAvatarItemId: item.CustomAvatarItemId }],
	})
})
it('protects source history, verifies upload ownership and hash, and never publishes unbuilt revisions', async () => {
	const { value: item } = await (await create()).json<{ value: { CustomAvatarItemId: string } }>()
	const url = base + '/' + item.CustomAvatarItemId + '/saves'
	const bytes = new TextEncoder().encode('{"Version":3}'),
		digest = await crypto.subtle.digest('SHA-256', bytes)
	await env.CDN_ASSETS.put('avatarunityasset/2026-10-18/source', bytes, {
		sha256: digest,
		customMetadata: { ownerId: '42' },
	})
	await env.CDN_ASSETS.put('image/thumb.png', 'thumbnail', {
		customMetadata: { ownerId: '42' },
		httpMetadata: { contentType: 'image/png' },
	})
	const body = {
		NewUnityAssetFile: {
			Filename: '2026-10-18/source',
			Hash: btoa(String.fromCharCode(...new Uint8Array(digest))),
		},
		BodyType: 1,
		ThumbnailFileName: 'thumb.png',
		AdditionalConfiguration: '{}',
		UpdateCurrentSaveIfPrivate: true,
	}
	const post = async (value: unknown, id = 42) =>
		SELF.fetch(url, {
			method: 'POST',
			headers: { ...(await headers(id)), 'Content-Type': 'application/json' },
			body: JSON.stringify(value),
		})
	expect((await post(body, 43)).status).toBe(403)
	expect(
		(await post({ ...body, NewUnityAssetFile: { ...body.NewUnityAssetFile, Hash: 'wrong' } }))
			.status
	).toBe(400)
	const response = await post(body)
	expect(response.status).toBe(200)
	const { value: saveId } = await response.json<{ value: number }>()
	expect(await (await env.IMAGES.get('thumb.png'))?.text()).toBe('thumbnail')
	expect((await SELF.fetch(url, { headers: await headers(43) })).status).toBe(403)
	const history = await SELF.fetch(url, { headers: await headers() })
	expect(await history.json()).toMatchObject({
		success: true,
		value: {
			TotalResults: 1,
			Results: [
				{
					CustomAvatarItemSaveId: saveId,
					SourceUnityAssetFilename: body.NewUnityAssetFile.Filename,
					UnityAsset: null,
				},
			],
		},
	})
	expect(
		(
			await SELF.fetch(url + '/' + saveId + '/publish', {
				method: 'POST',
				headers: await headers(),
			})
		).status
	).toBe(400)
	expect(
		(await post({ ...body, NewUnityAssetFile: null, ExistingUnityAssetId: crypto.randomUUID() }))
			.status
	).toBe(400)
})
it('allows creator metadata edits without exposing unbuilt items or changing ownership', async () => {
	const { value: item } = await (await create()).json<{ value: { CustomAvatarItemId: string } }>()
	const edit = async (body: unknown, id = 42) =>
		SELF.fetch(base + '/v1/' + item.CustomAvatarItemId, {
			method: 'PUT',
			headers: { ...(await headers(id)), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
	expect((await edit({ Name: 'Other owner' }, 43)).status).toBe(403)
	expect((await edit({ Accessibility: 1 })).status).toBe(400)
	expect((await edit({ Tags: [{ TagType: 1, Value: '' }] })).status).toBe(400)
	const response = await edit({
		Name: ' Updated hat ',
		Description: 'Edited in Studio',
		Tags: [{ TagType: 1, Value: 'hat' }],
		CreatorAccountId: 43,
	})
	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		value: {
			Name: 'Updated hat',
			Description: 'Edited in Studio',
			CreatorAccountId: 42,
			Accessibility: 0,
			Tags: [{ TagType: 1, Value: 'hat' }],
		},
	})
})

it('isolates outputs across reused-source bodies/configurations and preserves original restore', async () => {
	const { value: item } = await (await create()).json<{ value: { CustomAvatarItemId: string } }>()
	const asset = crypto.randomUUID()
	await env.DB.prepare(
		"INSERT INTO avatar_studio_save(id,item_id,body_type,unity_asset_id,source_filename,source_hash,thumbnail,configuration,created_at) VALUES (100,?,1,?,'same-source','same-hash','thumb.png','{}','now')"
	)
		.bind(item.CustomAvatarItemId, asset)
		.run()
	await env.DB.prepare(
		"INSERT INTO unity_asset VALUES (?,0,5,'main','original.bundle','original-hash')"
	)
		.bind(asset)
		.run()
	expect(await publishAvatarSave(env.DB, item.CustomAvatarItemId, 100)).toBe(true)
	await env.CDN_ASSETS.put('image/thumb.png', 'fixture', { customMetadata: { ownerId: '42' } })
	const url = base + '/' + item.CustomAvatarItemId + '/saves'
	const save = async (bodyType: number, config: string) => {
		const response = await SELF.fetch(url, {
			method: 'POST',
			headers: { ...(await headers()), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				ExistingUnityAssetId: asset,
				BodyType: bodyType,
				AdditionalConfiguration: config,
				ThumbnailFileName: 'thumb.png',
				UpdateCurrentSaveIfPrivate: true,
			}),
		})
		expect(response.status).toBe(200)
		const { value: id } = await response.json<{ value: number }>()
		return (await avatarStudioSave(env.DB, item.CustomAvatarItemId, id))!
	}
	const metadata = await save(1, '{}')
	expect(metadata.unity_asset_id).toBe(asset)
	const otherBody = await save(2, '{}'),
		otherConfig = await save(1, '{"variant":2}')
	for (const revision of [otherBody, otherConfig]) {
		expect(revision.unity_asset_id).not.toBe(asset)
		expect(revision.source_filename).toBe('same-source')
		expect(revision.source_hash).toBe('same-hash')
		expect((await avatarSaveDto(env.DB, revision)).UnityAsset).toBeNull()
		expect(await publishAvatarSave(env.DB, item.CustomAvatarItemId, revision.id)).toBe(false)
	}
	expect(otherBody.unity_asset_id).not.toBe(otherConfig.unity_asset_id)
	await env.DB.prepare(
		"INSERT INTO unity_asset VALUES (?,0,5,'main','other-body.bundle','other-hash')"
	)
		.bind(otherBody.unity_asset_id)
		.run()
	expect(await publishAvatarSave(env.DB, item.CustomAvatarItemId, otherBody.id)).toBe(true)
	expect(await publishAvatarSave(env.DB, item.CustomAvatarItemId, 100)).toBe(true)
	const stored = JSON.parse(
		(await env.DB.prepare('SELECT data FROM custom_avatar_item WHERE custom_avatar_item_id=?')
			.bind(item.CustomAvatarItemId)
			.first<{ data: string }>())!.data
	)
	expect(stored.CurrentSaves.find((s: { BodyType: number }) => s.BodyType === 1).UnityAsset).toBe(
		'original.bundle'
	)
	expect(stored.CurrentSaves.find((s: { BodyType: number }) => s.BodyType === 2).UnityAsset).toBe(
		'other-body.bundle'
	)
})
