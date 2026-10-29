import { describe, expect, it } from 'vitest'

import { roomForClientBuild } from '@repo/domain'

const scene = 'cbad71af-0831-44d8-b8ef-69edafa841f6'

describe('Rec Center 2024 compatibility', () => {
	it('preserves stored room and other subrooms when projecting the base scene', () => {
		const room = {
			RoomId: 2,
			SubRooms: [
				{
					SubRoomId: 2,
					UnitySceneId: scene,
					DataBlob: 'old',
					RoomDataBlob: 'another',
					PersistenceVersion: 227,
					CurrentSave: { DataBlob: 'new' },
				},
				{ SubRoomId: 3, UnitySceneId: 'other', CurrentSave: { DataBlob: 'other' } },
			],
		}
		const projected = roomForClientBuild(room, '20240621.01')
		expect(projected.SubRooms).toEqual([
			expect.objectContaining({
				SubRoomId: 2,
				DataBlob: '',
				RoomDataBlob: null,
				PersistenceVersion: 0,
				CurrentSave: null,
			}),
			room.SubRooms[1],
		])
		expect(room.SubRooms[0].CurrentSave).toEqual({ DataBlob: 'new' })
	})
	it('leaves other builds, rooms and scene IDs unchanged', () => {
		const room = {
			RoomId: 2,
			SubRooms: [{ SubRoomId: 2, UnitySceneId: scene, CurrentSave: { DataBlob: 'new' } }],
		}
		expect(roomForClientBuild(room, '20250718.01')).toBe(room)
		const otherRoom = { ...room, RoomId: 3 }
		expect(roomForClientBuild(otherRoom, '20240621')).toBe(otherRoom)
		const otherScene = { ...room, SubRooms: [{ ...room.SubRooms[0], UnitySceneId: 'other' }] }
		expect(roomForClientBuild(otherScene, '20240621')).toBe(otherScene)
	})
})
