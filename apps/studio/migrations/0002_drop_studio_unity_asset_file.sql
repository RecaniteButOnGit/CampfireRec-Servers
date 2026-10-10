-- A stored bundle is a row of the rooms worker's `unity_asset` now (its migration 0026
-- added the `kind` column this table carried): platform → target, r2_key → filename,
-- sha256 → hash. `studio_cloud_build` stays this worker's. Nothing is carried over.

DROP TABLE IF EXISTS studio_unity_asset_file;
