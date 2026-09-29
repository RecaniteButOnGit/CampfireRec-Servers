-- Converted ZIP scenes now carry persistence version 1. Match the room and its
-- published save metadata to that version for imports made by the website.
-- Restrict this to the importer's room shape and the current published save. Older
-- save history keeps the version recorded when it was written.
-- Scene blobs live in R2 and are not changed here; existing imports need a fresh
-- scene upload or re-import to replace their previously converted bytes.
UPDATE room
SET data = json_set(
  data,
  '$.PersistenceVersion',
  (
    SELECT MAX(
      CASE
        WHEN json_extract(saved.data, '$.PersistenceVersion') = 141
          AND json_extract(saved.data, '$.UgcSubVersion') = 0
          AND json_extract(saved.data, '$.OMVersion') = 0
          AND json_extract(saved.data, '$.SavedByAccountId') = 2
        THEN 1
        ELSE COALESCE(json_extract(saved.data, '$.PersistenceVersion'), 0)
      END
    )
    FROM subroom sub
    JOIN subroom_save saved ON saved.sub_room_data_save_id = sub.current_save_id
    WHERE sub.room_id = room.room_id
  )
)
WHERE creator_account_id = 2
  AND json_extract(data, '$.IsDorm') = 0
  AND json_extract(data, '$.CloningAllowed') = 0
  AND json_extract(data, '$.CreatedAt') >= '2026-09-28'
  AND EXISTS (
    SELECT 1
    FROM subroom sub
    JOIN subroom_save saved ON saved.sub_room_data_save_id = sub.current_save_id
    WHERE sub.room_id = room.room_id
      AND json_extract(saved.data, '$.PersistenceVersion') = 141
      AND json_extract(saved.data, '$.UgcSubVersion') = 0
      AND json_extract(saved.data, '$.OMVersion') = 0
      AND json_extract(saved.data, '$.SavedByAccountId') = 2
  );

UPDATE subroom_save
SET data = json_set(data, '$.PersistenceVersion', 1)
WHERE json_extract(data, '$.PersistenceVersion') = 141
  AND json_extract(data, '$.UgcSubVersion') = 0
  AND json_extract(data, '$.OMVersion') = 0
  AND json_extract(data, '$.SavedByAccountId') = 2
  AND EXISTS (
    SELECT 1
    FROM subroom sub
    JOIN room r ON r.room_id = sub.room_id
    WHERE sub.current_save_id = subroom_save.sub_room_data_save_id
      AND r.creator_account_id = 2
      AND json_extract(r.data, '$.IsDorm') = 0
      AND json_extract(r.data, '$.CloningAllowed') = 0
      AND json_extract(r.data, '$.CreatedAt') >= '2026-09-28'
  );
