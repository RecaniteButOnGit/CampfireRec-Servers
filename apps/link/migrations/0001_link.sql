-- Share links (`POST /actionlink`): a short code standing for something in the game — a
-- room, a club, an event — that a player can hand to someone else.
--
-- Each row is what the client sent, kept as sent:
--   code_type      the link's kind, the `codeType` form field (3 club · 4 event · 5 room seen)
--   extra_data_id  the id of the thing linked to, the `extraDataId` field (RoomId, ClubId,
--                  PlayerEventId); NULL when the client sends none
--   data           the `data` field verbatim: a JSON string `{ ExtraJson, Platform, Type }`
--                  whose ExtraJson is itself an escaped JSON string. Stored opaque; nothing
--                  here parses it
--   valid_hours    the `validHours` field; `expires_at` is created_at plus that many hours
--
-- `code` is the six-character code answered to the client, unique across every link.
-- A new code per request: asking twice for the same room gives two codes.

CREATE TABLE IF NOT EXISTS link (
  code TEXT PRIMARY KEY,
  creator_account_id INTEGER NOT NULL,
  code_type INTEGER NOT NULL,
  extra_data_id INTEGER,
  data TEXT,
  valid_hours INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_target ON link (code_type, extra_data_id);
