-- Converted ZIP imports made before this change used the scene converter's wire-format
-- minimum (123) as the save's client version too. Move only that distinctive import
-- signature (private room owned by account 2, published save at 123/123) to the 2025
-- client's observed MaxPersistenceVersion of 227. Keep the scene blob unchanged: its
-- embedded minimum version is a separate compatibility value.
UPDATE room
SET data = json_set(
  data,
  '$.PersistenceVersion',
  (
    SELECT MAX(
      CASE
        WHEN json_extract(saved.data, '$.PersistenceVersion') = 123
          AND json_extract(saved.data, '$.UgcSubVersion') = 123
          AND json_extract(saved.data, '$.SavedByAccountId') = 2
        THEN 227
        ELSE COALESCE(json_extract(saved.data, '$.PersistenceVersion'), 0)
      END
    )
    FROM subroom sub
    JOIN subroom_save saved ON saved.sub_room_data_save_id = sub.current_save_id
    WHERE sub.room_id = room.room_id
  )
)
WHERE creator_account_id = 2
  AND accessibility = 0
  AND json_extract(data, '$.PersistenceVersion') = 123
  AND EXISTS (
    SELECT 1
    FROM subroom sub
    JOIN subroom_save saved ON saved.sub_room_data_save_id = sub.current_save_id
    WHERE sub.room_id = room.room_id
      AND json_extract(saved.data, '$.PersistenceVersion') = 123
      AND json_extract(saved.data, '$.UgcSubVersion') = 123
      AND json_extract(saved.data, '$.SavedByAccountId') = 2
  );

UPDATE subroom_save
SET data = json_set(
  data,
  '$.PersistenceVersion', 227,
  '$.OMVersion', 0,
  '$.UgcSubVersion', 0
)
WHERE json_extract(data, '$.PersistenceVersion') = 123
  AND json_extract(data, '$.UgcSubVersion') = 123
  AND json_extract(data, '$.SavedByAccountId') = 2
  AND EXISTS (
    SELECT 1
    FROM subroom sub
    JOIN room r ON r.room_id = sub.room_id
    WHERE sub.current_save_id = subroom_save.sub_room_data_save_id
      AND r.creator_account_id = 2
      AND r.accessibility = 0
      AND json_extract(r.data, '$.PersistenceVersion') >= 227
  );
