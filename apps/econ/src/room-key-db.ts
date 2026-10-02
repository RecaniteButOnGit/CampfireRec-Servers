/**
 * Room keys — a room's own admission tickets.
 *
 * A creator lists a key for their room: a named, priced thing a player can hold to get
 * through a door the room locks. `room_key` is the LISTING — its name, its price, which room
 * it opens — and `room_key_player` is who HOLDS one. Nothing sells a key yet; a key reaches
 * a player by being awarded. The endpoints:
 *  - `POST /api/roomkeys/v1/create` lists one
 *  - `GET  /api/roomkeys/v1/room?roomId=` lists a room's
 *  - `PUT  /api/roomkeys/v1/updateAll` edits one
 *  - `POST /api/roomkeys/v1/awardbulk` awards the caller some
 *  - `GET  /api/storefronts/v1/buyRoomKey` sells the caller one, for tokens
 *  - `POST /api/storefronts/v1/PurchaseRoomKeyWithCurrency` sells one for its room currency
 *  - `POST /api/roomkeys/v1/owns/bulk` says who holds which
 *
 * This worker (`econ`) owns the tables and their migrations — see apps/econ/migrations/0024
 * and 0025.
 */

/** Schema DDL — also builds the tables in tests. Mirrors migrations 0024 and 0025. */
export const ROOM_KEY_SCHEMA_DDL: string[] = [
	// `room_key_id` is an AUTOINCREMENT rather than a GUID, unlike a room currency's: the
	// client's own model names a key by a numeric `RoomKeyId` (see the `notify` worker's
	// `LocalRoomKeyPayload`). `replication_id` is the GUID beside it, minted here.
	//
	// `key_type` is the body's `Type`, stored as the enum NAME it arrives as (`Key`) and served
	// back as the ORDINAL (`Type: 0`) — see {@link ROOM_KEY_TYPE_ORDINALS}. Only `Key` has
	// been observed.
	//
	// `purchase_currency_id` is the `room_currency` the key is charged in — null means tokens,
	// which is what a new key costs: the create body names none, and an edit can set it. `image_name` is '' in the row (NOT NULL), but the client reads
	// `ImageName` as null until a key carries art, so an empty column is served as null.
	`CREATE TABLE IF NOT EXISTS room_key (
		room_key_id INTEGER PRIMARY KEY AUTOINCREMENT,
		replication_id TEXT NOT NULL,
		room_id INTEGER NOT NULL,
		key_type TEXT NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		price INTEGER NOT NULL,
		purchase_currency_id TEXT,
		image_name TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	)`,
	// Every read is "this room's keys" — the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_room_key_room ON room_key (room_id)`,
	// Who holds a key: one row per (key, player). A key is held or it isn't — there is no
	// quantity — so the pair is the primary key and a repeat award changes nothing.
	`CREATE TABLE IF NOT EXISTS room_key_player (
		room_key_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		awarded_at TEXT NOT NULL,
		PRIMARY KEY (room_key_id, account_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_room_key_player_account ON room_key_player (account_id)`,
]

/**
 * The `Type` a key is served with: the ordinal of the client's key-type enum, keyed by the
 * NAME the create body posts (`Type=Key`). Only `Key` has been observed; an unrecognised name
 * is stored as posted and served as 0.
 */
export const ROOM_KEY_TYPE_ORDINALS: Readonly<Record<string, number>> = { Key: 0 }

/**
 * A room key as the client reads it — the `RoomKey` inside the create response's
 * `{ Status, RoomKey }`, member for member and in its order (observed from the live client),
 * and the `notify` worker's `LocalRoomKeyPayload`. The create endpoint answers this object and
 * the `LocalRoomKeyCreated` frame carries it, which is why `econ.app.ts` assigns one of these
 * straight to a `LocalRoomKeyPayload`: that assignment is what stops the two drifting apart.
 *
 * `Type` is the body's enum NAME served back as its ORDINAL (`Key` → 0), and `ImageName` is
 * NULL rather than '' until a key can carry art — both as the client sends and reads them.
 */
export interface RoomKey {
	RoomKeyId: number
	ReplicationId: string
	RoomId: number
	Name: string
	Description: string
	Price: number
	/** A `room_currency` id, or null for tokens — which is what a new key is priced in. */
	PurchaseCurrencyId: string | null
	/** ISO-8601 UTC. */
	CreatedAt: string
	/** Null until an edit gives the key art. */
	ImageName: string | null
	/** The key type's ordinal — 0 `Key`. See {@link ROOM_KEY_TYPE_ORDINALS}. */
	Type: number
}

/** What the create endpoint supplies; the ids and the timestamp are minted here. */
export interface NewRoomKey {
	RoomId: number
	/** The body's `Type`, an enum name (`Key`). Stored verbatim, served as its ordinal. */
	Type: string
	Name: string
	Description: string
	Price: number
}

interface RoomKeyRow {
	room_key_id: number
	replication_id: string
	room_id: number
	key_type: string
	name: string
	description: string
	price: number
	purchase_currency_id: string | null
	image_name: string
	created_at: string
}

const SELECT_COLUMNS = `room_key_id, replication_id, room_id, key_type, name, description, price, purchase_currency_id, image_name, created_at`

const toRoomKey = (row: RoomKeyRow): RoomKey => ({
	RoomKeyId: row.room_key_id,
	ReplicationId: row.replication_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	Price: row.price,
	PurchaseCurrencyId: row.purchase_currency_id,
	CreatedAt: row.created_at,
	ImageName: row.image_name === '' ? null : row.image_name,
	Type: ROOM_KEY_TYPE_ORDINALS[row.key_type] ?? 0,
})

/** List a room key, returning it as the client reads it back. */
export async function createRoomKey(db: D1Database, key: NewRoomKey): Promise<RoomKey> {
	const row = await db
		.prepare(
			`INSERT INTO room_key
			   (replication_id, room_id, key_type, name, description, price, purchase_currency_id, image_name, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, '', ?7)
			 RETURNING ${SELECT_COLUMNS}`
		)
		.bind(
			crypto.randomUUID(),
			key.RoomId,
			key.Type,
			key.Name,
			key.Description,
			key.Price,
			new Date().toISOString()
		)
		.first<RoomKeyRow>()

	return toRoomKey(row!)
}

/** One key by its id, or null when there is no such row. */
export async function getRoomKey(db: D1Database, roomKeyId: number): Promise<RoomKey | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_key WHERE room_key_id = ?1`)
		.bind(roomKeyId)
		.first<RoomKeyRow>()

	return row ? toRoomKey(row) : null
}

/** What an edit may change — the rest of a key (its ids, room, type, `CreatedAt`) is fixed. */
export interface RoomKeyChanges {
	Name: string
	Description: string
	Price: number
	/** A `room_currency` id, or null for tokens. */
	PurchaseCurrencyId: string | null
	/** The key's art, or null for none — stored as '' (the column is NOT NULL). */
	ImageName: string | null
}

/**
 * Rewrite a key's editable fields, returning it as it now stands — null when `roomKeyId`
 * names no listed key.
 */
export async function updateRoomKey(
	db: D1Database,
	roomKeyId: number,
	changes: RoomKeyChanges
): Promise<RoomKey | null> {
	const row = await db
		.prepare(
			`UPDATE room_key
			 SET name = ?2, description = ?3, price = ?4, purchase_currency_id = ?5, image_name = ?6
			 WHERE room_key_id = ?1
			 RETURNING ${SELECT_COLUMNS}`
		)
		.bind(
			roomKeyId,
			changes.Name,
			changes.Description,
			changes.Price,
			changes.PurchaseCurrencyId,
			changes.ImageName ?? ''
		)
		.first<RoomKeyRow>()

	return row ? toRoomKey(row) : null
}

/**
 * Every key a room has listed, oldest first — the order its owner built them up in. The
 * autoincrement id IS creation order, so it is the sort key.
 */
export async function getRoomKeys(db: D1Database, roomId: number): Promise<RoomKey[]> {
	const { results } = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_key WHERE room_id = ?1 ORDER BY room_key_id`)
		.bind(roomId)
		.all<RoomKeyRow>()

	return results.map(toRoomKey)
}

/**
 * Award a player a room key, answering when they came to hold it — now, or the first award's
 * time when they already did (a key is held once; re-awarding is a no-op). Null when
 * `roomKeyId` names no listed key: a held key that cannot be described is never written.
 */
export async function awardRoomKey(
	db: D1Database,
	accountId: number,
	roomKeyId: number
): Promise<string | null> {
	const [, held] = await db.batch<{ awarded_at: string }>([
		db
			.prepare(
				`INSERT OR IGNORE INTO room_key_player (room_key_id, account_id, awarded_at)
				 SELECT room_key_id, ?2, ?3 FROM room_key WHERE room_key_id = ?1`
			)
			.bind(roomKeyId, accountId, new Date().toISOString()),
		db
			.prepare('SELECT awarded_at FROM room_key_player WHERE room_key_id = ?1 AND account_id = ?2')
			.bind(roomKeyId, accountId),
	])
	return held.results[0]?.awarded_at ?? null
}

/** A (player, key) pair — one question put to `POST /api/roomkeys/v1/owns/bulk`. */
export interface RoomKeyHolding {
	AccountId: number
	RoomKeyId: number
}

/**
 * Whether each player holds each key — one answer per pair, in the order asked. A pair
 * naming an unknown key or player is simply not held.
 */
export async function ownsRoomKeys(db: D1Database, pairs: RoomKeyHolding[]): Promise<boolean[]> {
	if (pairs.length === 0) return []
	const held = db.prepare(
		'SELECT 1 AS held FROM room_key_player WHERE room_key_id = ?1 AND account_id = ?2'
	)
	const results = await db.batch<{ held: number }>(
		pairs.map((pair) => held.bind(pair.RoomKeyId, pair.AccountId))
	)
	return results.map((r) => r.results.length > 0)
}

/**
 * Take a key for a player ahead of charging them for it: true when this call made them its
 * holder, false when they already were (or the key is gone). The insert is the atomic step
 * a sale hangs on — two concurrent buys of one key cannot both claim it, so only one is
 * charged. A sale that then fails to collect gives the key back with {@link releaseRoomKey}.
 */
export async function claimRoomKey(
	db: D1Database,
	accountId: number,
	roomKeyId: number
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`INSERT OR IGNORE INTO room_key_player (room_key_id, account_id, awarded_at)
			 SELECT room_key_id, ?2, ?3 FROM room_key WHERE room_key_id = ?1`
		)
		.bind(roomKeyId, accountId, new Date().toISOString())
		.run()
	return meta.changes > 0
}

/** Undo a {@link claimRoomKey} whose sale did not go through. */
export async function releaseRoomKey(
	db: D1Database,
	accountId: number,
	roomKeyId: number
): Promise<void> {
	await db
		.prepare('DELETE FROM room_key_player WHERE room_key_id = ?1 AND account_id = ?2')
		.bind(roomKeyId, accountId)
		.run()
}

/**
 * Who a room's key sales pay — the room's `CreatorAccountId`, read off the `room` table's
 * generated column (the `rooms` worker owns the table). Null when there is no such room.
 */
export async function getRoomOwnerId(db: D1Database, roomId: number): Promise<number | null> {
	const row = await db
		.prepare('SELECT creator_account_id FROM room WHERE room_id = ?1')
		.bind(roomId)
		.first<{ creator_account_id: number | null }>()
	return row?.creator_account_id ?? null
}
