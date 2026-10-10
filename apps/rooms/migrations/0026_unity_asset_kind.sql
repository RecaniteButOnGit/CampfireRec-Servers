-- `unity_asset` gains a `kind`: Rec Room Studio builds store a `main` bundle (the scene the
-- client loads) and, optionally, a `stripped` editor-only bundle per target, and both are
-- rows here now that the studio worker writes this table instead of its own
-- `studio_unity_asset_file` (dropped by the studio migration 0002). The studio rows map
-- platform → target (windows 0, android 2), the R2 key → `filename` and the base64
-- SHA-256 → `hash`.
--
-- Generated from packages/domain/src/unity-assets-db.ts (UNITY_ASSET_SCHEMA_DDL) — keep in
-- sync. `kind` joins the primary key, which SQLite cannot alter in place, so the rows are
-- copied into a new table and KEPT: every existing row is a main bundle.

CREATE TABLE unity_asset_new (
  unity_asset_id TEXT NOT NULL,
  target INTEGER NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main',
  filename TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (unity_asset_id, target, version, kind)
);

INSERT INTO unity_asset_new (unity_asset_id, target, version, kind, filename, hash)
  SELECT unity_asset_id, target, version, 'main', filename, hash FROM unity_asset;

DROP TABLE unity_asset;
ALTER TABLE unity_asset_new RENAME TO unity_asset;
