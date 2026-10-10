-- Room experience — the XP a player has earned in one room.
--
-- Generated from packages/domain/src/room-xp-db.ts (ROOM_XP_SCHEMA_DDL) — keep in sync.
--
-- One row per (room, player), read by `GET /rooms/:id/experience/player` as `Experience`.
-- A player with no row reads as 0 XP; reads never insert. The `ConcurrencyCode` that
-- response carries is minted per response, not stored.
--
-- Whether a room has progression on, and its daily cap, live on the room blob
-- (`progressionEnabled` / `progressionDailyLimit`, set by `POST /rooms/:id/experience`).

CREATE TABLE IF NOT EXISTS room_xp (
  room_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, player_id)
);
