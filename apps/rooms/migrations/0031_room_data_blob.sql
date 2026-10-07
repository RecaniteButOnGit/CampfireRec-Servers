-- Earlier Campfire saves stored RoomData.Filename on the subroom as RoomDataBlob.
-- Recflare's room loader reads DataBlob on the room instead. Preserve the newest
-- saved metadata key when updating an existing database, without replacing a room
-- that already has a room-level DataBlob from a newer save.
UPDATE room
SET data = json_set(
  data,
  '$.DataBlob',
  (
    SELECT json_extract(s.data, '$.RoomDataBlob')
    FROM subroom AS s
    WHERE s.room_id = room.room_id
      AND json_type(s.data, '$.RoomDataBlob') = 'text'
      AND json_extract(s.data, '$.RoomDataBlob') <> ''
    ORDER BY COALESCE(json_extract(s.data, '$.DataSavedAt'), '') DESC, s.sub_room_id DESC
    LIMIT 1
  ),
  '$.DataBlobHash',
  NULL
)
WHERE COALESCE(json_type(data, '$.DataBlob'), 'null') = 'null'
  AND EXISTS (
    SELECT 1
    FROM subroom AS s
    WHERE s.room_id = room.room_id
      AND json_type(s.data, '$.RoomDataBlob') = 'text'
      AND json_extract(s.data, '$.RoomDataBlob') <> ''
  );
