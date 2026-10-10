-- Item wishlists, owned by the `econ` worker. One row per item a player has wished for —
-- what the store's heart toggle writes (`POST /api/itemWishlists/v1/wishlist/add|remove`,
-- form-encoded `purchasableItemId=1534&customAvatarItemId=`) and the wishlist page reads
-- (`GET /api/itemWishlists/v1/wishlist/me|{accountId}`, a bare array of entries).
--
-- `wishlist_item_id` is a GUID: the client's `WishlistItemId` is a `Guid`, not an int, so the
-- row's key has to be one. `player_id` is the account the list belongs to.
--
-- A row names ONE item in one of two ways — a catalog item by `purchasable_item_id` (the
-- storefront's `PurchasableItemId`) or a player-made/first-party custom avatar item by
-- `custom_avatar_item_id` (its GUID, stored lowercase) — so exactly one of the two is set.
-- On the wire the client's `PurchasableItemId` is a plain int, so a custom-item row is served
-- as `PurchasableItemId: 0` with the GUID beside it; the column is still NULL here so the two
-- kinds of row can't be confused.
--
-- The two partial unique indexes make a wish boolean: a second `add` of the same item finds
-- the existing row rather than making a twin. `idx_wishlist_player` is the read's access
-- pattern (one player's whole list).
--
-- Kept in sync with WISHLIST_SCHEMA_DDL in src/wishlist-db.ts.

CREATE TABLE IF NOT EXISTS wishlist (
  wishlist_item_id TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  purchasable_item_id INTEGER,
  custom_avatar_item_id TEXT,
  created_at TEXT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_wishlist_player ON wishlist (player_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_player_purchasable
  ON wishlist (player_id, purchasable_item_id) WHERE purchasable_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_player_custom
  ON wishlist (player_id, custom_avatar_item_id) WHERE custom_avatar_item_id IS NOT NULL;
