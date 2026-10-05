/**
 * Item wishlists — the store's heart toggle.
 *
 * A player wishes for an item from its store page and reads the list back on the wishlist
 * page; other players can read it too (that is what a wishlist is for). One row per
 * (player, item) in `wishlist`. The endpoints, all on `/api/itemWishlists/v1`:
 *  - `GET  …/wishlist/me` and `…/wishlist/:accountId` — a bare array of entries
 *  - `POST …/wishlist/add` and `…/wishlist/remove` — form-encoded, enveloped
 *  - `POST …/isonwishlist/bulk` — a bare array of booleans, one per account asked about
 *
 * An entry names ONE item in one of two ways: a catalog item by `PurchasableItemId` (the
 * storefront's id, what `RRUI.Data.StoreItemModel` toggles) or a custom avatar item by
 * `CustomAvatarItemId` (its GUID, what `CustomAvatarItemModel` toggles). Both columns are
 * nullable and exactly one is set — but the client's `PurchasableItemId` is a plain `int`,
 * so a custom-item row is SERVED as `PurchasableItemId: 0`; see {@link toWishlistItem}.
 *
 * This worker (`econ`) owns the table and its migration — see apps/econ/migrations/
 * 0027_wishlist.sql.
 */

/** Schema DDL (mirror of migrations/0027_wishlist.sql) — also builds the table in tests. */
export const WISHLIST_SCHEMA_DDL: string[] = [
	// `wishlist_item_id` is a GUID: the client's `WishlistItemId` is a `Guid`, so the row's
	// key has to be one. `custom_avatar_item_id` is stored LOWERCASE so the unique index below
	// holds whatever case the client sent the GUID in.
	`CREATE TABLE IF NOT EXISTS wishlist (
		wishlist_item_id TEXT PRIMARY KEY,
		player_id INTEGER NOT NULL,
		purchasable_item_id INTEGER,
		custom_avatar_item_id TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_wishlist_player ON wishlist (player_id)`,
	// A wish is boolean: these make a second `add` of the same item find the existing row.
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_player_purchasable
		ON wishlist (player_id, purchasable_item_id) WHERE purchasable_item_id IS NOT NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_player_custom
		ON wishlist (player_id, custom_avatar_item_id) WHERE custom_avatar_item_id IS NOT NULL`,
]

/**
 * A wishlist entry as the client reads it (its `AMJGGOKLEGL`, five keys in this order). The
 * same object is an element of the GET's bare array and the `Value` of the add/remove
 * envelope.
 *
 * `PurchasableItemId` is a plain `int` on the client — there is no null to send — so a
 * custom-item entry carries 0 there and its GUID in `CustomAvatarItemId`, which IS nullable
 * and null on a catalog-item entry.
 */
export interface WishlistItem {
	/** GUID, minted here. */
	WishlistItemId: string
	AccountId: number
	/** The storefront item wished for, or 0 when the entry names a custom avatar item. */
	PurchasableItemId: number
	/** The custom avatar item wished for, or null when the entry names a storefront item. */
	CustomAvatarItemId: string | null
	/** ISO-8601 UTC. */
	CreatedAt: string
}

/**
 * Which item a request is about — exactly one of the two, already parsed. The add/remove/
 * isonwishlist bodies all name an item this way (`purchasableItemId=1534&customAvatarItemId=`,
 * the unused one empty), and `parseWishlistTarget` turns that into one of these or null.
 */
export type WishlistTarget =
	| { purchasableItemId: number; customAvatarItemId: null }
	| { purchasableItemId: null; customAvatarItemId: string }

/** The 36-char dashed GUID the client's formatter writes and reads; braces or `N` form fail it. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Read the item a wishlist body names. Both fields are always posted (the client boxes two
 * nullables without a HasValue guard, so the unused one arrives empty), and a hand-written
 * request may leave one out — either is accepted. The storefront id wins when both are
 * somehow set. Null when neither names anything usable: no id, a non-integer id, or a string
 * that isn't a GUID.
 */
export function parseWishlistTarget(
	purchasableItemId: unknown,
	customAvatarItemId: unknown
): WishlistTarget | null {
	const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
	const id = str(purchasableItemId)
	if (/^\d+$/.test(id)) {
		const n = Number(id)
		if (n > 0) return { purchasableItemId: n, customAvatarItemId: null }
	}
	const guid = str(customAvatarItemId)
	if (GUID_RE.test(guid)) {
		return { purchasableItemId: null, customAvatarItemId: guid.toLowerCase() }
	}
	return null
}

interface WishlistRow {
	wishlist_item_id: string
	player_id: number
	purchasable_item_id: number | null
	custom_avatar_item_id: string | null
	created_at: string
}

const SELECT_COLUMNS = `wishlist_item_id, player_id, purchasable_item_id, custom_avatar_item_id, created_at`

const toWishlistItem = (row: WishlistRow): WishlistItem => ({
	WishlistItemId: row.wishlist_item_id,
	AccountId: row.player_id,
	PurchasableItemId: row.purchasable_item_id ?? 0,
	CustomAvatarItemId: row.custom_avatar_item_id,
	CreatedAt: row.created_at,
})

/** The WHERE clause that picks a target's row(s), with the target bound as `?<param>`. */
function targetClause(
	target: WishlistTarget,
	param: number
): { sql: string; value: number | string } {
	return target.purchasableItemId !== null
		? { sql: `purchasable_item_id = ?${param}`, value: target.purchasableItemId }
		: { sql: `custom_avatar_item_id = ?${param}`, value: target.customAvatarItemId }
}

/**
 * A player's wishlist, newest wish first — the order the reference served (its capture lists
 * 15:37:08 above 15:36:56). A player who has wished for nothing gets [].
 */
export async function getWishlist(db: D1Database, playerId: number): Promise<WishlistItem[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SELECT_COLUMNS} FROM wishlist WHERE player_id = ?1
			 ORDER BY created_at DESC, wishlist_item_id`
		)
		.bind(playerId)
		.all<WishlistRow>()
	return results.map(toWishlistItem)
}

/** The player's entry for an item, or null when it isn't on their list. */
export async function getWishlistItem(
	db: D1Database,
	playerId: number,
	target: WishlistTarget
): Promise<WishlistItem | null> {
	const where = targetClause(target, 2)
	const row = await db
		.prepare(`SELECT ${SELECT_COLUMNS} FROM wishlist WHERE player_id = ?1 AND ${where.sql}`)
		.bind(playerId, where.value)
		.first<WishlistRow>()
	return row === null ? null : toWishlistItem(row)
}

/**
 * Wish for an item. A wish is boolean, so an item already on the list is answered with its
 * EXISTING entry — original id and `CreatedAt` — rather than a twin or a refusal: the client
 * toggles by its own idea of the current state, and a stale page re-adding something changes
 * nothing. The unique indexes back this up under a race, in which case the loser re-reads.
 */
export async function addWishlistItem(
	db: D1Database,
	playerId: number,
	target: WishlistTarget,
	now: Date = new Date()
): Promise<WishlistItem> {
	const existing = await getWishlistItem(db, playerId, target)
	if (existing !== null) return existing
	const row: WishlistRow = {
		wishlist_item_id: crypto.randomUUID(),
		player_id: playerId,
		purchasable_item_id: target.purchasableItemId,
		custom_avatar_item_id: target.customAvatarItemId,
		created_at: now.toISOString(),
	}
	const { meta } = await db
		.prepare(`INSERT OR IGNORE INTO wishlist (${SELECT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5)`)
		.bind(
			row.wishlist_item_id,
			row.player_id,
			row.purchasable_item_id,
			row.custom_avatar_item_id,
			row.created_at
		)
		.run()
	if (meta.changes === 0) {
		// Lost a race with an identical add: the row that won is the entry.
		const winner = await getWishlistItem(db, playerId, target)
		if (winner !== null) return winner
	}
	return toWishlistItem(row)
}

/**
 * Take an item off a player's list. Answers the entry that was removed, or null when the item
 * wasn't on the list — which the caller treats as success: the list ends up as asked either
 * way, and the client discards the value.
 */
export async function removeWishlistItem(
	db: D1Database,
	playerId: number,
	target: WishlistTarget
): Promise<WishlistItem | null> {
	const where = targetClause(target, 2)
	const row = await db
		.prepare(
			`DELETE FROM wishlist WHERE player_id = ?1 AND ${where.sql} RETURNING ${SELECT_COLUMNS}`
		)
		.bind(playerId, where.value)
		.first<WishlistRow>()
	return row === null ? null : toWishlistItem(row)
}

/**
 * Which of `playerIds` have `target` on their list — one boolean per id, in the order given,
 * so the caller can serve the client's positional `List<bool>`. Duplicated ids each get their
 * own answer; an unknown player simply hasn't wished for it.
 */
export async function isOnWishlists(
	db: D1Database,
	playerIds: number[],
	target: WishlistTarget
): Promise<boolean[]> {
	if (playerIds.length === 0) return []
	const where = targetClause(target, 1)
	const placeholders = playerIds.map((_, i) => `?${i + 2}`).join(', ')
	const { results } = await db
		.prepare(`SELECT player_id FROM wishlist WHERE ${where.sql} AND player_id IN (${placeholders})`)
		.bind(where.value, ...playerIds)
		.all<{ player_id: number }>()
	const wished = new Set(results.map((r) => r.player_id))
	return playerIds.map((id) => wished.has(id))
}
