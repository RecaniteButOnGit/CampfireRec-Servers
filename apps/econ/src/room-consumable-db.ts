/**
 * Room consumables — the things a room sells.
 *
 * The other half of a room's economy: `room-currency-db.ts` mints the money ("MySpecialTokens")
 * and hands it out, and this is the shop that takes it back — a Health Potion for 25 tokens,
 * a custom shirt for 500. A consumable is the LISTING: its name, its picture, what it costs
 * and in which of the room's currencies.
 *
 * The endpoints:
 *  - `PUT /api/roomconsumables/v1/roomConsumable` creates one, or edits it when the body
 *    names an existing `RoomConsumableId`
 *  - `GET /api/roomconsumables/v1/roomConsumable/room/{roomId}` lists a room's
 *  - `POST /api/roomconsumables/v1/roomConsumable/awardBulk` gives one to a player
 *  - `PUT /api/roomconsumables/v1/roomconsumable/{id}/purchase/tokens` and `…/purchase/currency`
 *    sell one, in tokens or the listing's room currency
 *  - `PUT /api/roomconsumables/v1/roomConsumable/{id}/consume` uses up one the caller holds
 *
 * `PurchaseCurrencyId` is a `room_currency`, so a room prices its goods in its own money. It
 * is nullable — `Guid?` in the client's model — for a listing that names no currency, and
 * nothing here resolves or validates it yet: a consumable priced in a currency that has since
 * been deleted still lists, at a price nobody can pay.
 *
 * A null `PurchaseCurrencyId` is priced in TOKENS, which the purchase pays to the room's
 * owner; `MaximumCountPerPurchase` caps a purchase's `Quantity` (0 means no cap).
 *
 * This worker (`econ`) owns the tables and their migrations — see apps/econ/migrations/,
 * 0021 (the listings) and 0022 (what players own of them).
 */

/** Schema DDL (mirror of migrations 0021_room_consumable.sql) — also builds the table in tests. */
export const ROOM_CONSUMABLE_SCHEMA_DDL: string[] = [
	// `room_consumable_id` is a GUID rather than an autoincrement, like a room currency's: it
	// is how the client names this listing afterwards, and a room's consumables are created
	// independently of every other room's.
	//
	// `image_name` and `purchase_currency_id` are nullable because the client's model has them
	// so — a listing with no picture, or none priced in a room currency. `price` is not: a
	// listing always has a price, even if it is zero.
	//
	// The body's `PriceAndCurrency` object is COLLAPSED here into `price` and
	// `purchase_currency_id`. It is one price in one currency, and a nested object would buy
	// nothing but a JSON blob to query through.
	`CREATE TABLE IF NOT EXISTS room_consumable (
		room_consumable_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		image_name TEXT,
		price INTEGER NOT NULL,
		purchase_currency_id TEXT,
		modified_at TEXT NOT NULL,
		maximum_count_per_purchase INTEGER NOT NULL DEFAULT 0
	)`,
	// Every read is "this room's shop" — the whole access pattern.
	`CREATE INDEX IF NOT EXISTS idx_room_consumable_room ON room_consumable (room_id)`,
]

/**
 * One room consumable as the client reads it — its own model, member for member and in its
 * order, taken from the client's field layout.
 *
 * Note `Price`/`PurchaseCurrencyId` here against the `PriceAndCurrency` object the write
 * takes: the client sends them nested and reads them flat, so the two shapes are not the same
 * and must not be unified.
 */
export interface RoomConsumable {
	RoomConsumableId: string
	RoomId: number
	Name: string
	Description: string
	/** Null for a listing with no picture. */
	ImageName: string | null
	Price: number
	/** A `room_currency` id — the room's own money. Nullable in the client's model. */
	PurchaseCurrencyId: string | null
	/** ISO-8601 UTC. */
	ModifiedAt: string
	/** How many may be bought at once; 0 is no cap. */
	MaximumCountPerPurchase: number
}

/** What the write supplies. The id is minted on a create and kept on an edit. */
export interface NewRoomConsumable {
	RoomId: number
	Name: string
	Description: string
	ImageName: string | null
	Price: number
	PurchaseCurrencyId: string | null
	MaximumCountPerPurchase: number
}

interface RoomConsumableRow {
	room_consumable_id: string
	room_id: number
	name: string
	description: string
	image_name: string | null
	price: number
	purchase_currency_id: string | null
	modified_at: string
	maximum_count_per_purchase: number
}

const SELECT_COLUMNS = `room_consumable_id, room_id, name, description, image_name, price, purchase_currency_id, modified_at, maximum_count_per_purchase`

const toRoomConsumable = (row: RoomConsumableRow): RoomConsumable => ({
	RoomConsumableId: row.room_consumable_id,
	RoomId: row.room_id,
	Name: row.name,
	Description: row.description,
	ImageName: row.image_name,
	Price: row.price,
	PurchaseCurrencyId: row.purchase_currency_id,
	ModifiedAt: row.modified_at,
	MaximumCountPerPurchase: row.maximum_count_per_purchase,
})

/** One consumable by its id, or null when there is no such row. */
export async function getRoomConsumable(
	db: D1Database,
	roomConsumableId: string
): Promise<RoomConsumable | null> {
	const row = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM room_consumable WHERE room_consumable_id = ?1`)
		.bind(roomConsumableId)
		.first<RoomConsumableRow>()

	return row ? toRoomConsumable(row) : null
}

/**
 * Create a listing, or replace one when `roomConsumableId` names an existing row.
 *
 * One function because the client uses one call for both — a `PUT` whose `RoomConsumableId`
 * is null on a create and the listing's id on an edit — and because the two write the same
 * columns. An edit REPLACES rather than merges: the client sends the whole form back, so an
 * absent field is a cleared field, not an unmentioned one. (That is the opposite of the
 * currency edit, whose body is genuinely partial.)
 *
 * `ModifiedAt` is set on both. `RoomId` is written from the caller's already-checked value,
 * so an edit cannot move a listing into another room — the room comes off the STORED listing
 * on an edit, never the body.
 */
export async function upsertRoomConsumable(
	db: D1Database,
	roomConsumableId: string | null,
	consumable: NewRoomConsumable
): Promise<RoomConsumable> {
	const row: RoomConsumableRow = {
		room_consumable_id: roomConsumableId ?? crypto.randomUUID(),
		room_id: consumable.RoomId,
		name: consumable.Name,
		description: consumable.Description,
		image_name: consumable.ImageName,
		price: consumable.Price,
		purchase_currency_id: consumable.PurchaseCurrencyId,
		modified_at: new Date().toISOString(),
		maximum_count_per_purchase: consumable.MaximumCountPerPurchase,
	}

	await db
		.prepare(
			`INSERT INTO room_consumable (${SELECT_COLUMNS})
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			 ON CONFLICT (room_consumable_id) DO UPDATE SET
			   name = ?3, description = ?4, image_name = ?5, price = ?6,
			   purchase_currency_id = ?7, modified_at = ?8, maximum_count_per_purchase = ?9`
		)
		.bind(
			row.room_consumable_id,
			row.room_id,
			row.name,
			row.description,
			row.image_name,
			row.price,
			row.purchase_currency_id,
			row.modified_at,
			row.maximum_count_per_purchase
		)
		.run()

	return toRoomConsumable(row)
}

/**
 * A room's shop, oldest first — the order the owner built it up in, which is the order they
 * expect to see it in. A room that sells nothing is an empty list.
 */
export async function getRoomConsumables(
	db: D1Database,
	roomId: number
): Promise<RoomConsumable[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM room_consumable
			 WHERE room_id = ?1 ORDER BY modified_at, room_consumable_id`
		)
		.bind(roomId)
		.all<RoomConsumableRow>()

	return results.map(toRoomConsumable)
}

/**
 * What a player owns of a room's consumables — the shop's other side, filled by
 * `POST /api/roomconsumables/v1/roomConsumable/awardBulk` and by the purchase.
 *
 * Keyed by CONSUMABLE, not by room: `room_consumable` already says which room a listing
 * belongs to, and repeating it here would be a second place for that to be wrong. A missing
 * row is a quantity of zero — nothing is inserted until a player is first given one, so a
 * room's shop costs a row per player who actually owns something rather than one per player
 * who has looked at it.
 *
 * `consumable_id` is not a foreign key, but the award route checks the listing exists before
 * writing: an inventory row naming nothing would be a thing a player owns that cannot be
 * described.
 *
 * `concurrency_code` is the last `NewConcurrencyCode` a write sent, served back as the item's
 * `ConcurrencyCode`; nothing checks it — no optimistic concurrency is implemented. It and
 * `modified_at` came in migration 0029, so a row older than that has both null.
 */
export const ROOM_INVENTORY_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS room_inventory (
		player_id INTEGER NOT NULL,
		consumable_id TEXT NOT NULL,
		quantity INTEGER NOT NULL DEFAULT 0,
		concurrency_code TEXT,
		modified_at TEXT,
		PRIMARY KEY (player_id, consumable_id)
	)`,
	// "What does this player own?" is the read the client makes on entering a room, so the
	// player half of the key earns its own index for the lookups that start there.
	`CREATE INDEX IF NOT EXISTS idx_room_inventory_player ON room_inventory (player_id)`,
]

/**
 * The listing as it rides inside a {@link RoomConsumableInventoryItem}: the catalogue's
 * {@link RoomConsumable} plus `IsGiftable` and `Visibility`, and `ImageName` as '' rather
 * than null — observed from the live client, and NOT what the room's catalogue
 * (`GET …/roomConsumable/room/{roomId}`) serves. Neither extra field is modelled here, so
 * both are their false/0.
 */
export interface InventoryConsumable extends Omit<RoomConsumable, 'ImageName'> {
	ImageName: string
	IsGiftable: boolean
	Visibility: number
}

/**
 * What a player owns of one consumable, as the client reads it — `RoomConsumableInventoryItem`,
 * observed from the live client. The element of `GET …/roomConsumable/room/{roomId}/me` and
 * the `InventoryItem` a purchase answers with.
 */
export interface RoomConsumableInventoryItem {
	RoomConsumableId: string
	AccountId: number
	/** The RESULTING total owned, never the change. */
	Count: number
	/** The last `NewConcurrencyCode` written; null on a row older than migration 0029. */
	ConcurrencyCode: string | null
	/** ISO-8601 UTC — the last write; the listing's own time on a row older than 0029. */
	ModifiedAt: string
	Consumable: InventoryConsumable
}

/** What a player holds of one consumable — the row, before it is joined to its listing. */
export interface RoomInventoryHolding {
	quantity: number
	concurrencyCode: string | null
	modifiedAt: string | null
}

/** Project a holding and its listing onto the client's inventory item. */
export function toInventoryItem(
	accountId: number,
	holding: RoomInventoryHolding,
	consumable: RoomConsumable
): RoomConsumableInventoryItem {
	return {
		RoomConsumableId: consumable.RoomConsumableId,
		AccountId: accountId,
		Count: holding.quantity,
		ConcurrencyCode: holding.concurrencyCode,
		ModifiedAt: holding.modifiedAt ?? consumable.ModifiedAt,
		Consumable: {
			...consumable,
			ImageName: consumable.ImageName ?? '',
			IsGiftable: false,
			Visibility: 0,
		},
	}
}

/**
 * Give a player some of a consumable, returning what they hold afterwards. `concurrencyCode`
 * is the request's `NewConcurrencyCode`, stored to be served back; null leaves the stored one.
 *
 * Floored at zero in the statement itself, so a negative `quantity` deducts without a
 * deduction and a concurrent award racing it below zero. Returns the RESULTING total, never
 * the change — the same rule the currency balances follow, and for the same reason: every
 * surface that shows an inventory shows the total.
 *
 * Read BACK rather than taken from a `RETURNING`, for the reason {@link awardRoomCurrency}
 * spells out: an empty RETURNING is indistinguishable from an award that changed nothing, so
 * a write that didn't land would report a plausible-looking but wrong total. All three
 * statements are one `batch`, which D1 runs as a transaction.
 */
export async function awardRoomConsumable(
	db: D1Database,
	playerId: number,
	consumableId: string,
	quantity: number,
	concurrencyCode: string | null = null
): Promise<RoomInventoryHolding> {
	const read = db.prepare(
		`SELECT quantity, concurrency_code, modified_at FROM room_inventory
		 WHERE player_id = ?1 AND consumable_id = ?2`
	)
	const [, , after] = await db.batch<{
		quantity: number
		concurrency_code: string | null
		modified_at: string | null
	}>([
		read.bind(playerId, consumableId),
		db
			.prepare(
				`INSERT INTO room_inventory (player_id, consumable_id, quantity, concurrency_code, modified_at)
				 VALUES (?1, ?2, MAX(0, ?3), ?4, ?5)
				 ON CONFLICT (player_id, consumable_id) DO UPDATE SET
				   quantity = MAX(0, room_inventory.quantity + ?3),
				   concurrency_code = COALESCE(?4, room_inventory.concurrency_code),
				   modified_at = ?5`
			)
			.bind(playerId, consumableId, quantity, concurrencyCode, new Date().toISOString()),
		read.bind(playerId, consumableId),
	])

	// No row means a quantity of zero — nothing is inserted until a player is first given one.
	const row = after.results[0]
	return {
		quantity: row?.quantity ?? 0,
		concurrencyCode: row?.concurrency_code ?? null,
		modifiedAt: row?.modified_at ?? null,
	}
}

/**
 * Use up ONE of a consumable a player holds, returning what they hold afterwards — or null
 * when they hold none, and nothing was written. `concurrencyCode` is the request's
 * `NewConcurrencyCode`, stored to be served back; null leaves the stored one.
 *
 * A single conditional UPDATE: the `quantity >= 1` guard is what refuses, so two consumes
 * racing over the last one cannot both succeed. Here an empty `RETURNING` is exactly the
 * answer wanted — "you had none" — unlike the award, where it would be ambiguous.
 */
export async function consumeRoomConsumable(
	db: D1Database,
	playerId: number,
	consumableId: string,
	concurrencyCode: string | null = null
): Promise<RoomInventoryHolding | null> {
	const row = await db
		.prepare(
			`UPDATE room_inventory SET
			   quantity = quantity - 1,
			   concurrency_code = COALESCE(?3, concurrency_code),
			   modified_at = ?4
			 WHERE player_id = ?1 AND consumable_id = ?2 AND quantity >= 1
			 RETURNING quantity, concurrency_code, modified_at`
		)
		.bind(playerId, consumableId, concurrencyCode, new Date().toISOString())
		.first<{ quantity: number; concurrency_code: string | null; modified_at: string | null }>()

	return row
		? {
				quantity: row.quantity,
				concurrencyCode: row.concurrency_code,
				modifiedAt: row.modified_at,
			}
		: null
}

/**
 * Everything a player owns of one room's consumables, in the shop's order. A listing they own
 * none of is absent — including one they held and spent down to zero.
 */
export async function getRoomInventory(
	db: D1Database,
	roomId: number,
	playerId: number
): Promise<RoomConsumableInventoryItem[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS.split(', ')
				.map((col) => `c.${col}`)
				.join(', ')},
			   i.quantity AS quantity, i.concurrency_code AS concurrency_code,
			   i.modified_at AS inventory_modified_at
			 FROM room_inventory AS i
			 JOIN room_consumable AS c ON c.room_consumable_id = i.consumable_id
			 WHERE c.room_id = ?1 AND i.player_id = ?2 AND i.quantity > 0
			 ORDER BY c.modified_at, c.room_consumable_id`
		)
		.bind(roomId, playerId)
		.all<
			RoomConsumableRow & {
				quantity: number
				concurrency_code: string | null
				inventory_modified_at: string | null
			}
		>()

	return results.map((row) =>
		toInventoryItem(
			playerId,
			{
				quantity: row.quantity,
				concurrencyCode: row.concurrency_code,
				modifiedAt: row.inventory_modified_at,
			},
			toRoomConsumable(row)
		)
	)
}
