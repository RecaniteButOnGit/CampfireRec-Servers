-- Give save-less Rooms 2.0 subrooms the verified Empty subroom save so the client has
-- real scene bytes to download before PRE_INSTANTIATE_OBJECTS. This covers the seeded
-- MakerRoom2 template and clones created before cloneRoom began minting their own saves.
-- Existing saves and staged pointers are left untouched.
INSERT INTO subroom_save (sub_room_id, data)
SELECT
  s.sub_room_id,
  json_object(
    'UnitySubAssets', json('[]'),
    'ReferencedUnityAssets', json('[]'),
    'UnityAssetId', NULL,
    'DataBlob', 'templates/rooms2/empty-obbytemplate/7xd0rcm7jwv1l2heirlvhi1zh.room',
    'DataBlobHash', 'E7rpId42w2QfuBNkTFpQgLL2gJ72u+6yMAU/DNfweBA=',
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
WHERE json_extract(r.data, '$.UgcVersion') = 2
  AND json_extract(s.data, '$.UnitySceneId') = '5d4e40d8-f289-4295-a6e1-4f907835007d'
  AND s.current_save_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM subroom_save history WHERE history.sub_room_id = s.sub_room_id
  );

-- These rows were just inserted above, so each qualifying subroom has one matching save.
UPDATE subroom
SET current_save_id = (
  SELECT sv.sub_room_data_save_id
  FROM subroom_save sv
  WHERE sv.sub_room_id = subroom.sub_room_id
  ORDER BY sv.sub_room_data_save_id DESC
  LIMIT 1
)
WHERE current_save_id IS NULL
  AND json_extract(data, '$.UnitySceneId') = '5d4e40d8-f289-4295-a6e1-4f907835007d'
  AND EXISTS (
    SELECT 1 FROM room r
    WHERE r.room_id = subroom.room_id
      AND json_extract(r.data, '$.UgcVersion') = 2
  )
  AND EXISTS (
    SELECT 1 FROM subroom_save sv
    WHERE sv.sub_room_id = subroom.sub_room_id
      AND json_extract(sv.data, '$.DataBlob') = 'templates/rooms2/empty-obbytemplate/7xd0rcm7jwv1l2heirlvhi1zh.room'
  );
