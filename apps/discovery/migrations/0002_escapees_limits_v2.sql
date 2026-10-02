-- Existing completed Escapees imports should receive the same room setting as new imports.
INSERT INTO room_tag (room_id, tag, type, is_primary_genre)
SELECT job.room_id, 'limitsv2', 1, 0
FROM escapees_import_job AS job
JOIN room ON room.room_id = job.room_id
WHERE job.state = 'done'
  AND job.room_id IS NOT NULL
  AND json_extract(room.data, '$.CreatorAccountId') = job.rr_account_id
ON CONFLICT (room_id, tag) DO UPDATE SET type = 1, is_primary_genre = 0;
