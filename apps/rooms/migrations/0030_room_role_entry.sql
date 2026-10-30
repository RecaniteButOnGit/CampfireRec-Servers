-- Give `room_role` the whole role entry, not just which account a room names.
--
-- 0029 stored (account_id, room_id) alone, which is all `getContributedRooms` asks of it.
-- A table of a room's roles should carry the roles themselves, though: each row now mirrors
-- one `Roles` entry from the room blob, so a query that cares about the tier (managers only,
-- pending invites) can filter on it here instead of going back to `json_each` over every
-- room. The blob is still the source of truth, and `roomRoleWrites` still rewrites a room's
-- rows alongside every write that changes `Roles`.
--
-- Columns follow `roomRoles()`, which fills in what older entries lack: `role` and
-- `invited_role` default to 0 (Role.None), `last_changed_by_account_id` to null.
--
-- Nothing reads the table until the worker deploys, so it is rebuilt rather than altered.
-- The triggers are dropped in case an early draft of 0029 created them; they are not used.

DROP TRIGGER IF EXISTS room_role_insert;
DROP TRIGGER IF EXISTS room_role_update;
DROP TRIGGER IF EXISTS room_role_delete;
DROP TABLE IF EXISTS room_role;

CREATE TABLE room_role (
	account_id INTEGER NOT NULL,
	room_id INTEGER NOT NULL,
	role INTEGER NOT NULL DEFAULT 0,
	invited_role INTEGER NOT NULL DEFAULT 0,
	last_changed_by_account_id INTEGER,
	PRIMARY KEY (account_id, room_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_room_role_room ON room_role (room_id);

-- Backfill from the rooms already stored. Like 0029's, it is a full rebuild, so it can be
-- re-run as-is after the deploy to catch role changes the old code made in between.
-- Non-object entries are skipped through a CASE rather than handed to json_extract, which
-- raises on a bare string.
DELETE FROM room_role;
INSERT OR IGNORE INTO room_role (account_id, room_id, role, invited_role, last_changed_by_account_id)
SELECT account_id, room_id, COALESCE(role, 0), COALESCE(invited_role, 0), last_changed_by_account_id
FROM (
	SELECT room.room_id AS room_id,
	       CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.AccountId') END AS account_id,
	       CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.Role') END AS role,
	       CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.InvitedRole') END AS invited_role,
	       CASE WHEN r.type = 'object' THEN json_extract(r.value, '$.LastChangedByAccountId') END AS last_changed_by_account_id
	FROM room, json_each(room.data, '$.Roles') AS r
) WHERE account_id > 0 AND room_id IS NOT NULL;
