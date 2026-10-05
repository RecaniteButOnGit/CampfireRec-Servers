-- Which inventions a room has in it — one row per (room, invention).
--
-- Generated from packages/domain/src/rooms-db.ts (SUBROOM_SCHEMA_DDL) — keep in sync.
--
-- A room save (`POST /rooms/:id/subrooms/:sid/data`) carries `InventionUsage`, a base64
-- protobuf listing the inventions in the saved scene (see `decodeInventionUsage`). Each
-- save re-derives the room's rows here from every one of its subrooms, so the table is the
-- union across the room and an invention removed from it drops out on the next save.
--
-- Empty until rooms are next saved: the `InventionUsage` already stored on subrooms is not
-- backfilled, since decoding it is not something SQL can do.

CREATE TABLE IF NOT EXISTS room_invention (
  room_id INTEGER NOT NULL,
  invention_id INTEGER NOT NULL,
  PRIMARY KEY (room_id, invention_id)
);

-- The reverse lookup: which rooms use this invention.
CREATE INDEX IF NOT EXISTS idx_room_invention_invention ON room_invention (invention_id);
