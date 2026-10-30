-- Index the room-badge lookup that hydrates every room list (`attachBadges` in
-- packages/domain/src/rooms-db.ts). Every room page — feeds, search, the owned list, a single
-- room read — asks this table for the published badges of the rooms on the page, and without an
-- index that was a full scan of every custom avatar item (thousands of first-party rows) per
-- page. At the time of writing it was half of the database's row reads.
--
-- PARTIAL, over only the badge rows (`OutfitType` 1000), keyed by the badge's room. SQLite uses
-- a partial index only when the query's WHERE contains its term as written, and an expression
-- index only when the query names the same expression, so the query must keep BOTH
-- `outfit_type = 1000` and `json_extract(data, '$.CustomBadgeMetadata.RoomId')` exactly —
-- change either and the index silently stops being used. The key is an expression rather than
-- a new generated column so the query reads the same whether or not this migration has run yet
-- (the `rooms` worker can deploy ahead of `api`'s migrations).
-- Generated from src/custom-avatar-items-db.ts (SCHEMA_DDL) — keep in sync.

CREATE INDEX IF NOT EXISTS idx_custom_avatar_item_badge_room
  ON custom_avatar_item (json_extract(data, '$.CustomBadgeMetadata.RoomId'))
  WHERE outfit_type = 1000;
