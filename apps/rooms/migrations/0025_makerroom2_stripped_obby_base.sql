-- Use the user's stripped Empty ObbyTemplate save as the MakerRoom2 starter.
-- Keep the prior save history so existing room clones continue to resolve.
INSERT INTO subroom_save (sub_room_id, data)
SELECT
  s.sub_room_id,
  json_object(
    'UnitySubAssets', json('[]'),
    'ReferencedUnityAssets', json('[]'),
    'UnityAssetId', NULL,
    'DataBlob', 'templates/rooms2/empty-obbytemplate/rooms2-obby-empty-stripped.room',
    'DataBlobHash', '4SsRzh8zm+YOp4rGd2NInObD0CLg1q5NWprTcGjathQ=',
    'ReferencedUnityAssetIds', json('["3bbd34ae-7fff-4bd5-81f7-0645ce297ef9","84ce9009-5afa-492f-9005-281877ea37e6","e06c10f5-9ae2-4d75-a79f-93a1e5c43585","7263f0b2-1d87-4a57-b724-b0665d752cfa","17d4e1ce-f868-407b-9425-bc43d592cdc3","f95761d7-1d7d-47db-96b7-ee0dfef4c97f","e31a99bf-711c-4ad0-997d-eede2b4c2d07"]'),
    'PersistenceVersion', 179,
    'OMVersion', 151,
    'UgcSubVersion', 330,
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
      AND json_extract(saved.data, '$.DataBlob') = 'templates/rooms2/empty-obbytemplate/rooms2-obby-empty-stripped.room'
  );

UPDATE subroom
SET current_save_id = (
  SELECT saved.sub_room_data_save_id
  FROM subroom_save saved
  WHERE saved.sub_room_id = subroom.sub_room_id
    AND json_extract(saved.data, '$.DataBlob') = 'templates/rooms2/empty-obbytemplate/rooms2-obby-empty-stripped.room'
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
      AND json_extract(saved.data, '$.DataBlob') = 'templates/rooms2/empty-obbytemplate/rooms2-obby-empty-stripped.room'
  );

UPDATE room
SET data = json_set(data, '$.Description', 'An empty Rooms 2.0 room for building whatever you like.')
WHERE room_id = 46
  AND name = 'MakerRoom2'
  AND json_extract(data, '$.UgcVersion') = 2;
