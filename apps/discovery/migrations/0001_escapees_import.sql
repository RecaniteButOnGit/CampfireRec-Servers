CREATE TABLE IF NOT EXISTS escapees_import_job (
  map_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  rr_account_id INTEGER NOT NULL,
  room_name TEXT NOT NULL,
  description TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'error')),
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  room_id INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escapees_import_pending ON escapees_import_job (state, updated_at);
