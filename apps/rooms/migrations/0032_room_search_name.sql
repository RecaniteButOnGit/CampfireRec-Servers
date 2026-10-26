-- The searchable rooms by lowercased name, for the website's header search
-- (`GET /rooms/search/name`, searchRoomsByName).
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- PARTIAL over exactly SEARCHABLE_WHERE, so a prefix seek visits only rooms it can serve
-- and the LIMIT stops it: D1 bills the rows returned, not the room count. The existing
-- `idx_rooms_name_lower` holds every dorm and private room, and each one the seek passed
-- would be read to test the filters. Built from the VIRTUAL columns, so no backfill.
CREATE INDEX IF NOT EXISTS idx_room_search_name ON room (name_lower)
 WHERE is_dorm IS NOT 1 AND accessibility = 1 AND exclude_from_search IS NOT 1;
