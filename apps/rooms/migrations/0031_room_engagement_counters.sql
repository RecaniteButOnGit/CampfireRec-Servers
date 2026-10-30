-- Cheer and favorite counters on `room`, as columns — the cheer/favorite twins of
-- `visits` (0011).
--
-- Generated from packages/domain/src/rooms-db.ts (ROOM_SCHEMA_DDL) — keep in sync.
--
-- Until now `Stats.CheerCount`/`FavoriteCount` were DERIVED on every read by aggregating
-- the per-player `interaction` rows (`SELECT room_id, SUM(cheered), SUM(favorited) …
-- GROUP BY room_id`). 0021's covering index made the per-room form cheap, but the browse
-- and discovery feeds rank EVERY listable room, so they ran the unfiltered form — a walk
-- of the whole index per call — and the discovery page runs the hot feed once per
-- category row. That was the bulk of the database's reads.
--
-- Now each counter is kept current by the toggles themselves: the same batch that flips a
-- player's `interaction.cheered`/`favorited` applies a `cheers = cheers ± 1` to the room,
-- so a cheer still shows immediately and concurrent toggles can't lose each other. The
-- per-player rows stay the record of WHO cheered; the columns are the count of them.
--
-- The backfill below is the one remaining full aggregate, run once here. `room_id` is a
-- virtual generated column, so the correlated subquery resolves it per row; the sums come
-- off `idx_interaction_room` without touching the table.

ALTER TABLE room ADD COLUMN cheers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room ADD COLUMN favorites INTEGER NOT NULL DEFAULT 0;

UPDATE room SET
	cheers = (SELECT COALESCE(SUM(cheered), 0) FROM interaction WHERE interaction.room_id = room.room_id),
	favorites = (SELECT COALESCE(SUM(favorited), 0) FROM interaction WHERE interaction.room_id = room.room_id);
