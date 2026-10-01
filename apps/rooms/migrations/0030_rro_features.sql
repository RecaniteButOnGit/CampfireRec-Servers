-- RRO classification also enables the beta and Limits V2 room features. Bring rooms
-- marked before the website action gained those settings up to the same state.
-- Dorms are excluded even though the seeded dorm template carries IsRRO.
UPDATE room
SET data = json_set(
  data,
  '$.IsRRO', json('true'),
  '$.IsDeveloperOwned', json('true'),
  '$.RestrictedCircuitsAllowListNames',
  json(
    CASE WHEN EXISTS (
      SELECT 1
      FROM json_each(COALESCE(json_extract(data, '$.RestrictedCircuitsAllowListNames'), '[]'))
      WHERE value = 'Create Analytics Event Payload'
    ) THEN COALESCE(json_extract(data, '$.RestrictedCircuitsAllowListNames'), '[]')
    ELSE json_insert(
      COALESCE(json_extract(data, '$.RestrictedCircuitsAllowListNames'), '[]'),
      '$[#]', 'Create Analytics Event Payload'
    ) END
  )
)
WHERE is_dorm IS NOT 1
  AND (
    json_extract(data, '$.IsRRO') = 1
    OR EXISTS (
      SELECT 1 FROM room_tag
      WHERE room_tag.room_id = room.room_id AND tag = 'rro' AND type = 2
    )
  );

INSERT INTO room_tag (room_id, tag, type, is_primary_genre)
SELECT room_id, 'rro', 2, 0 FROM room
WHERE is_dorm IS NOT 1 AND json_extract(data, '$.IsRRO') = 1
ON CONFLICT (room_id, tag) DO UPDATE SET type = 2, is_primary_genre = 0;

INSERT INTO room_tag (room_id, tag, type, is_primary_genre)
SELECT room_id, 'beta', 1, 0 FROM room
WHERE is_dorm IS NOT 1 AND json_extract(data, '$.IsRRO') = 1
ON CONFLICT (room_id, tag) DO UPDATE SET type = 1, is_primary_genre = 0;

INSERT INTO room_tag (room_id, tag, type, is_primary_genre)
SELECT room_id, 'limitsv2', 1, 0 FROM room
WHERE is_dorm IS NOT 1 AND json_extract(data, '$.IsRRO') = 1
ON CONFLICT (room_id, tag) DO UPDATE SET type = 1, is_primary_genre = 0;
