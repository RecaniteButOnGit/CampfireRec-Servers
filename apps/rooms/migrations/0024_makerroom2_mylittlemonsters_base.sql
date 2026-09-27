-- Replace MakerRoom2's original blank save with the user-provided MyLittleMonsters
-- Rooms 2.0 save. Its UnitySceneId matches the Rooms 2.0 scene, and the linked Studio
-- UnityAssetId is retained in the save metadata. Older clones keep their prior save.
INSERT INTO subroom_save (sub_room_id, data)
SELECT
  s.sub_room_id,
  json_object(
    'UnitySubAssets', json('[]'),
    'ReferencedUnityAssets', json('[]'),
    'UnityAssetId', '14fcbddc-7106-4b8e-961c-513bb8379001',
    'DataBlob', 'templates/rooms2/mylittlemonsters/b095j1ikk9vu9j8wl3jwq5eht.room',
    'DataBlobHash', 'OcQkZaED9IAXylh7y1B+T1Dxz/Z+wa40vY2jYj+DPLs=',
    'ReferencedUnityAssetIds', json('[]'),
    'PersistenceVersion', 136,
    'OMVersion', 2,
    'UgcSubVersion', 138,
    'SavedByAccountId', COALESCE(json_extract(s.data, '$.CreatorAccountId'), r.creator_account_id, 1),
    'SavedOnPlatform', 0,
    'SavedOnDeviceClass', 0,
    'Description', '',
    'Tags', json('[]'),
    'ModerationState', 0,
    'CreatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
FROM subroom s
JOIN room r ON r.room_id = s.room_id
WHERE s.room_id = 46
  AND r.name = 'MakerRoom2'
  AND json_extract(r.data, '$.UgcVersion') = 2
  AND json_extract(s.data, '$.UnitySceneId') = '5d4e40d8-f289-4295-a6e1-4f907835007d'
  AND NOT EXISTS (
    SELECT 1 FROM subroom_save saved
    WHERE saved.sub_room_id = s.sub_room_id
      AND json_extract(saved.data, '$.DataBlob') = 'templates/rooms2/mylittlemonsters/b095j1ikk9vu9j8wl3jwq5eht.room'
  );

-- Make the new snapshot live on MakerRoom2 without changing any existing clones.
UPDATE subroom
SET current_save_id = (
  SELECT saved.sub_room_data_save_id
  FROM subroom_save saved
  WHERE saved.sub_room_id = subroom.sub_room_id
    AND json_extract(saved.data, '$.DataBlob') = 'templates/rooms2/mylittlemonsters/b095j1ikk9vu9j8wl3jwq5eht.room'
  ORDER BY saved.sub_room_data_save_id DESC
  LIMIT 1
)
WHERE room_id = 46
  AND json_extract(data, '$.UnitySceneId') = '5d4e40d8-f289-4295-a6e1-4f907835007d'
  AND EXISTS (
    SELECT 1 FROM room r
    WHERE r.room_id = 46
      AND r.name = 'MakerRoom2'
      AND json_extract(r.data, '$.UgcVersion') = 2
  )
  AND EXISTS (
    SELECT 1 FROM subroom_save saved
    WHERE saved.sub_room_id = subroom.sub_room_id
      AND json_extract(saved.data, '$.DataBlob') = 'templates/rooms2/mylittlemonsters/b095j1ikk9vu9j8wl3jwq5eht.room'
  );

UPDATE room
SET data = json_set(data, '$.Description', 'An editable Rooms 2.0 starter based on MyLittleMonsters.')
WHERE room_id = 46
  AND name = 'MakerRoom2'
  AND json_extract(data, '$.UgcVersion') = 2;
