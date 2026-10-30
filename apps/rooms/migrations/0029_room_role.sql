-- Index a room's `Roles` by account, so "rooms this account has a role in"
-- (`getContributedRooms`) is a lookup instead of a scan.
--
-- Roles live in the room blob, and the only way to ask "which rooms name account N" of
-- the blob is a `json_each` over every room's `$.Roles`: the whole table, every blob
-- parsed, on every call. `room_role` is a DERIVED copy of those entries, one row per
-- (account, room). The blob stays the source of truth; every write in
-- `packages/domain/src/rooms-db.ts` that changes `Roles` batches `roomRoleWrites` with it.
--
-- Every entry with an `AccountId` counts, pending invites (`InvitedRole` only) included,
-- which is exactly what the json_each query matched.

CREATE TABLE IF NOT EXISTS room_role (
	account_id INTEGER NOT NULL,
	room_id INTEGER NOT NULL,
	PRIMARY KEY (account_id, room_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_room_role_room ON room_role (room_id);

-- Backfill from the rooms already stored. A full rebuild rather than an append, so this can
-- be re-run as-is to catch role changes made by the old code between migrating and deploying.
-- Non-object entries are skipped through a CASE rather than handed to json_extract, which
-- raises on a bare string.
DELETE FROM room_role;
INSERT OR IGNORE INTO room_role (account_id, room_id)
SELECT account_id, room_id FROM (
	SELECT CASE WHEN role.type = 'object' THEN json_extract(role.value, '$.AccountId') END AS account_id,
	       room.room_id AS room_id
	FROM room, json_each(room.data, '$.Roles') AS role
) WHERE account_id > 0 AND room_id IS NOT NULL;
