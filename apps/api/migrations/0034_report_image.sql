-- Reporting a saved IMAGE (`POST /api/images/v1/{id}/report`) reuses the report table, as
-- the event, invention, custom-avatar-item and chat-message reports beside it do: same
-- fields, same moderation life. Generated from src/reports-db.ts (SCHEMA_DDL) — keep in sync.
--
-- `image_id` names the reported image (`image.id`). NULL on every other kind of report, and
-- mutually exclusive with `event_id`, `invention_id`, `custom_avatar_item_id` and
-- `chat_message_id`.
--
-- The request has no body, so the row is three facts: the reporter (the caller), the image,
-- and `reported_player_id` — the image's `PlayerId`, who took it, read from the image.
-- `report_category` stays 0 and `details` NULL: the client sends neither.
--
-- NOT indexed, like the other kind columns: written on every report of this kind and read by
-- nothing. Add an index with the query that needs it.

ALTER TABLE report ADD COLUMN image_id INTEGER;
