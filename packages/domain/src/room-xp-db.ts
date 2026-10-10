/**
 * Room experience — the per-room XP a player earns in a room that has progression
 * turned on (`POST /rooms/:id/experience`, the `rooms` worker), on the shared `recflare` D1.
 *
 * `room_xp` holds one row per (room, player): the XP earned so far. A player with no row
 * has earned nothing there and reads as 0 — no row is written on a read.
 *
 * The `ConcurrencyCode` the client reads from `GET /rooms/:id/experience/player` is NOT
 * stored: it is a per-response GUID that only travels in requests, minted by the route.
 *
 * The room-level switch and its daily cap are not here either: they are
 * `progressionEnabled` and `progressionDailyLimit` on the room blob (see
 * `setRoomProgression` in rooms-db.ts).
 *
 * The `rooms` worker owns the table and its migration — see
 * apps/rooms/migrations/0025_room_xp.sql.
 */

/** Schema DDL (mirror of apps/rooms/migrations/0025_room_xp.sql) — tests apply this. */
export const ROOM_XP_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_xp (
		room_id INTEGER NOT NULL,
		player_id INTEGER NOT NULL,
		xp INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (room_id, player_id)
	)`,
]

/**
 * A player's XP in a room. Never writes: a player who has earned nothing in the room reads
 * as 0, so a row only appears once XP is first recorded.
 */
export async function getRoomExperience(
	db: D1Database,
	roomId: number,
	playerId: number
): Promise<number> {
	const row = await db
		.prepare('SELECT xp FROM room_xp WHERE room_id = ?1 AND player_id = ?2')
		.bind(roomId, playerId)
		.first<{ xp: number }>()
	return row?.xp ?? 0
}

/** Record a player's XP in a room as an absolute value. Creates the row on first write. */
export async function setRoomExperience(
	db: D1Database,
	roomId: number,
	playerId: number,
	xp: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO room_xp (room_id, player_id, xp) VALUES (?1, ?2, ?3)
			 ON CONFLICT(room_id, player_id) DO UPDATE SET xp = ?3`
		)
		.bind(roomId, playerId, xp)
		.run()
}

/**
 * Add to a player's XP in a room and return the new total. Creates the row on first write;
 * a negative `delta` subtracts, and the total is never clamped.
 */
export async function incrementRoomExperience(
	db: D1Database,
	roomId: number,
	playerId: number,
	delta: number
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO room_xp (room_id, player_id, xp) VALUES (?1, ?2, ?3)
			 ON CONFLICT(room_id, player_id) DO UPDATE SET xp = xp + ?3
			 RETURNING xp`
		)
		.bind(roomId, playerId, delta)
		.first<{ xp: number }>()
	// RETURNING always yields the upserted row.
	return row!.xp
}
