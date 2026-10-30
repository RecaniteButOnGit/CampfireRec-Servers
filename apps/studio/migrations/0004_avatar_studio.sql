CREATE TABLE IF NOT EXISTS avatar_studio_access (account_id INTEGER PRIMARY KEY, flags INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, modified_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS avatar_studio_save (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, body_type INTEGER NOT NULL, unity_asset_id TEXT NOT NULL, source_filename TEXT NOT NULL, source_hash TEXT NOT NULL, thumbnail TEXT NOT NULL, moderation_image TEXT, configuration TEXT NOT NULL, description TEXT, update_current INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_avatar_studio_save_item ON avatar_studio_save(item_id,id);
CREATE TABLE IF NOT EXISTS studio_avatar_build (cloud_build_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, save_id INTEGER NOT NULL);
