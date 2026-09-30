import { zipSync } from 'fflate'
import { expect, it } from 'vitest'

import { convertAvatarData, readAvatarUpload } from '../avatar-import'
import { avatarDataFixture } from './avatar-fixture'

it('converts AvatarData selections into worn and saved client payloads', () => {
	const { avatar, worn, saved } = convertAvatarData(avatarDataFixture)
	expect(avatar.OutfitSelections).toBe('03020100-0504-0706-0809-0a0b0c0d0e0f,,1')
	expect(JSON.parse(avatar.OutfitSelectionsV2 as string).selections[0]).toMatchObject({
		PrefabGuid: '03020100-0504-0706-0809-0a0b0c0d0e0f',
		BodyPart: 1,
	})
	expect(avatar.SkinColor).toBe('AAECAwQFBgcICQoLDA0ODw')
	expect(JSON.parse(avatar.FaceFeatures as string).ver).toBe(6)
	expect(worn.Slot).toBe(0)
	expect((worn.LegacyData as Record<string, unknown>).SelectionsV1).toBe(avatar.OutfitSelections)
	expect(worn.CustomizationSettings).toBeNull()
	expect(saved.Slot).toBe(1)
	expect(saved.LegacyData).toEqual(worn.LegacyData)
	expect(saved.Name).toBe('Imported avatar')
})

it('reads the named file directly or from a nested ZIP entry', async () => {
	const direct = new File([new Uint8Array(avatarDataFixture)], 'AvatarData.binpb')
	expect(await readAvatarUpload(direct)).toEqual(avatarDataFixture)
	const zipped = new File(
		[new Uint8Array(zipSync({ 'Export/AvatarData.binpb': avatarDataFixture }))],
		'avatar.zip'
	)
	expect(await readAvatarUpload(zipped)).toEqual(avatarDataFixture)
})

it('refuses missing and duplicate avatar entries', async () => {
	const missing = new File([new Uint8Array(zipSync({ 'Other.binpb': avatarDataFixture }))], 'a.zip')
	await expect(readAvatarUpload(missing)).rejects.toThrow('exactly one AvatarData.binpb')
	const duplicate = new File(
		[
			new Uint8Array(
				zipSync({
					'A/AvatarData.binpb': avatarDataFixture,
					'B/AvatarData.binpb': avatarDataFixture,
				})
			),
		],
		'a.zip'
	)
	await expect(readAvatarUpload(duplicate)).rejects.toThrow('more than one')
	expect(() => convertAvatarData(new Uint8Array([8, 1]))).toThrow('no outfit selections')
})
