import { strToU8, zipSync } from 'fflate'
import { expect, it } from 'vitest'

import { readRoomArchive } from '../room-archive'

it('reads a room export and skips listed subrooms without scene files', async () => {
	const zip = zipSync({
		'BloodFlower/RoomDetails.json': strToU8(
			JSON.stringify({
				Name: 'BloodFlower',
				SubRooms: [{ Name: 'OldUpdate' }, { Name: 'RRSUpdate' }],
			})
		),
		'BloodFlower/RoomImage.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
		'BloodFlower/SubRoom_123_OldUpdate/Subroom.json': strToU8(
			JSON.stringify({ Name: 'OldUpdate', CurrentSave: { PersistenceVersion: 153 } })
		),
		'BloodFlower/SubRoom_123_OldUpdate/persisted_room_data.binpb': new Uint8Array([8, 1]),
		'BloodFlower/SubRoom_123_OldUpdate/persisted_room_data.original.binpb': new Uint8Array([
			0xf0, 0x01, 83,
		]),
		'BloodFlower/SubRoom_456_RRSUpdate/Subroom.json': strToU8(
			JSON.stringify({ Name: 'RRSUpdate', CurrentSave: { UnityAssetId: 'rrs-asset' } })
		),
		'BloodFlower/SubRoom_456_RRSUpdate/persisted_room_data.binpb': new Uint8Array([8, 2]),
		'BloodFlower/SubRoom_123_OldUpdate/CV2Audio/Node_SampleAudio_8s9mgoy07z9cn3btawtolp294.htr.binpb':
			new Uint8Array([3, 4, 5]),
		'BloodFlower/SubRoom_456_RRSUpdate/CV2Audio/Node_SampleAudio_8s9mgoy07z9cn3btawtolp294.htr.binpb':
			new Uint8Array([3, 4, 5]),
		'BloodFlower/SubRoom_123_OldUpdate/CV2Audio/Node_SampleAudio_8s9mgoy07z9cn3btawtolp294.htr.wav':
			new Uint8Array([6, 7]),
		'BloodFlower/SubRoom_123_OldUpdate/AudioSampler/PVHolotar_d6wmvlq0dfm4xs0h33320g14z.htr.binpb':
			new Uint8Array([7, 8]),
		'BloodFlower/Inventions/Invention_1/Scene.glb': new Uint8Array([1, 2, 3]),
	})
	const archive = await readRoomArchive(new File([new Uint8Array(zip)], 'BloodFlower.zip'))
	expect(archive.details.Name).toBe('BloodFlower')
	expect(archive.image.type).toBe('image/jpeg')
	expect(archive.subRooms).toHaveLength(1)
	expect(archive.subRooms[0]?.details.Name).toBe('OldUpdate')
	expect(archive.subRooms[0]?.save.PersistenceVersion).toBe(153)
	expect(archive.subRooms[0]?.originalFile?.name).toBe('persisted_room_data.original.binpb')
	expect(new Uint8Array(await archive.subRooms[0]!.originalFile!.arrayBuffer())).toEqual(
		new Uint8Array([0xf0, 0x01, 83])
	)
	expect(archive.skippedSubRooms).toBe(1)
	expect(archive.audio).toHaveLength(2)
	expect(archive.audio[0]?.blobName).toBe('8s9mgoy07z9cn3btawtolp294.htr')
	expect(new Uint8Array(await archive.audio[0]!.file.arrayBuffer())).toEqual(
		new Uint8Array([3, 4, 5])
	)
	expect(archive.audio[1]?.blobName).toBe('d6wmvlq0dfm4xs0h33320g14z.htr')
})
