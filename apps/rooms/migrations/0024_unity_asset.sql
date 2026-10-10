-- Baked unity asset bundles — the blob references behind a room's asset-bundle download.
--
-- Generated from packages/domain/src/unity-assets-db.ts (UNITY_ASSET_SCHEMA_DDL) — keep in
-- sync.
--
-- One row per BUILD of a unity asset: the asset's GUID (stored lowercase), the target it was
-- built for (0 Windows, 2 Android/Quest), its version, and the storage blob the client
-- downloads — `filename` is a `<date>/<guid>` path and `hash` its base64 SHA-256. The client
-- reads these in bulk from `POST /unity_assets/baked/bulk` (form-encoded
-- `target=0&version=3&id=<guid>&id=<guid>`) while loading a room, and downloads `filename`
-- from the CDN. A lookup that finds no row downloads nothing, silently.
--
-- Separate from the Rec Room Studio builds in `studio_unity_asset_file` (the studio worker's,
-- per platform and kind). Nothing writes this table yet.

CREATE TABLE IF NOT EXISTS unity_asset (
  unity_asset_id TEXT NOT NULL,
  target INTEGER NOT NULL,
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (unity_asset_id, target, version)
);
