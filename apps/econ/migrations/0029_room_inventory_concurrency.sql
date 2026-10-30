-- What a player holds of a room consumable now remembers its last write: `concurrency_code`
-- (the request's `NewConcurrencyCode`) and `modified_at`. Owned by the `econ` worker; generated
-- from src/room-consumable-db.ts (ROOM_INVENTORY_SCHEMA_DDL, which mirrors the table as it
-- stands AFTER this migration) — keep in sync.
--
-- Both are served on the client's `RoomConsumableInventoryItem` (`GET
-- …/roomConsumable/room/{roomId}/me`, and the purchase's `InventoryItem`) as `ConcurrencyCode`
-- and `ModifiedAt`. The code is stored to be echoed, not checked — no optimistic concurrency is
-- implemented. Nullable: rows written before this have neither, and are served a null code and
-- the listing's own `ModifiedAt`.
ALTER TABLE room_inventory ADD COLUMN concurrency_code TEXT;

ALTER TABLE room_inventory ADD COLUMN modified_at TEXT;
