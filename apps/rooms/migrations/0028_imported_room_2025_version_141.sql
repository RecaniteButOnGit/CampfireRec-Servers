-- 0027 stamped converted ZIP imports with 227. The Campfire Rec 2025 client uses
-- persistence version 141 for the last saved version. Correct existing imported
-- saves while leaving their converted scene blobs (minimum wire version 123) alone.
-- The importer's owner, creation date, and room shape narrow this to its own rooms;
-- a real save on another room must retain the version it recorded.
UPDATE room
SET data = json_set(
  data,
  '$.PersistenceVersion',
  (
    SELECT MAX(
      CASE
        WHEN json_extract(saved.data, '$.PersistenceVersion') = 227
          AND json_extract(saved.data, '$.UgcSubVersion') = 0
          AND json_extract(saved.data, '$.OMVersion') = 0
          AND json_extract(saved.data, '$.SavedByAccountId') = 2
        THEN 141
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
      AND json_extract(saved.data, '$.PersistenceVersion') = 227
      AND json_extract(saved.data, '$.UgcSubVersion') = 0
      AND json_extract(saved.data, '$.OMVersion') = 0
      AND json_extract(saved.data, '$.SavedByAccountId') = 2
  );

UPDATE subroom_save
SET data = json_set(data, '$.PersistenceVersion', 141)
WHERE json_extract(data, '$.PersistenceVersion') = 227
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
