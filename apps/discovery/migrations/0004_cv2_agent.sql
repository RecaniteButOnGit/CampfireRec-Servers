CREATE TABLE IF NOT EXISTS cv2_agent_run (
  run_id TEXT PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  room_id INTEGER NOT NULL,
  sub_room_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','aborted')),
  base_save_id INTEGER,
  final_save_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cv2_agent_one_active_subroom
  ON cv2_agent_run(sub_room_id) WHERE state IN ('queued','running');
