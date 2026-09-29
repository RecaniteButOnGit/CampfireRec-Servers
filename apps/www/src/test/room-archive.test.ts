import { strToU8, zipSync } from 'fflate'
import { expect, it } from 'vitest'

import { readRoomArchive } from '../room-archive'

it('reads a room export and skips listed subrooms without scene files', async () => {
	const zip = zipSync({
		'BloodFlower/RoomDetails.json': strToU8(
			JSON.stringify({ Name: 'BloodFlower', SubRooms: [{ Name: 'OldUpdate' }, { Name: 'RRSUpdate' }] })
		),
		'BloodFlower/RoomImage.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
		'BloodFlower/SubRoom_123_OldUpdate/Subroom.json': strToU8(
			JSON.stringify({ Name: 'OldUpdate', CurrentSave: { PersistenceVersion: 153 } })
		),
		'BloodFlower/SubRoom_123_OldUpdate/persisted_room_data.binpb': new Uint8Array([8, 1]),
		'BloodFlower/Inventions/Invention_1/Scene.glb': new Uint8Array([1, 2, 3]),
	})
	const archive = await readRoomArchive(new File([new Uint8Array(zip)], 'BloodFlower.zip'))
	expect(archive.details.Name).toBe('BloodFlower')
	expect(archive.image.type).toBe('image/jpeg')
	expect(archive.subRooms).toHaveLength(1)
	expect(archive.subRooms[0]?.details.Name).toBe('OldUpdate')
	expect(archive.subRooms[0]?.save.PersistenceVersion).toBe(153)
	expect(archive.skippedSubRooms).toBe(1)
})
