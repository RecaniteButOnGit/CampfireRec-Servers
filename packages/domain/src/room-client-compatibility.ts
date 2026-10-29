import type { Room } from './rooms-db'

/**
 * The June 2024 client can load the built-in Rec Center scene, but cannot read
 * the later published save. Serve that build the base scene without changing
 * the published save or other clients' room data. This is a compatibility
 * fallback, not a conversion of objects or circuits.
 */
export function roomForClientBuild(room: Room, build: string): Room {
	if (build.split('.')[0] !== '20240621' || room.RoomId !== 2 || !Array.isArray(room.SubRooms))
		return room
	let changed = false
	const subRooms = room.SubRooms.map((value: unknown) => {
		if (!value || typeof value !== 'object') return value
		const sub = value as Record<string, unknown>
		if (sub.SubRoomId !== 2 || sub.UnitySceneId !== 'cbad71af-0831-44d8-b8ef-69edafa841f6')
			return value
		changed = true
		return { ...sub, CurrentSave: null, DataBlob: '', RoomDataBlob: null, PersistenceVersion: 0 }
	})
	return changed ? { ...room, SubRooms: subRooms } : room
}
