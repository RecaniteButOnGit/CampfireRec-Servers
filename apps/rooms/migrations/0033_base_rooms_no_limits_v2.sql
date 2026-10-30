-- Base templates do not use Limits V2; their newly created clones enable it instead.
DELETE FROM room_tag
WHERE tag = 'limitsv2'
  AND room_id IN (SELECT room_id FROM room_tag WHERE tag = 'base');
