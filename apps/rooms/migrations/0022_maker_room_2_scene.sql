-- MakerRoom2 was seeded with the legacy MakerRoom (Basement) scene. Existing
-- Rooms 2.0 room data uses the Rooms 2.0 scene. Correct only the untouched
-- seeded template; player rooms and already-created clones are left alone.
UPDATE subroom
SET data = json_set(data, '$.UnitySceneId', '5d4e40d8-f289-4295-a6e1-4f907835007d')
WHERE room_id = 46
  AND json_extract(data, '$.UnitySceneId') = 'a75f7547-79eb-47c6-8986-6767abcb4f92'
  AND EXISTS (
    SELECT 1 FROM room
    WHERE room_id = 46
      AND name = 'MakerRoom2'
      AND json_extract(data, '$.UgcVersion') = 2
  );
