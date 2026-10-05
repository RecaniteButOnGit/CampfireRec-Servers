-- An invention's `NumDownloads` is the number of players who have it: the rows in
-- `inventory_invention` that name it. `grantInvention` now re-derives it on every grant
-- (packages/domain/src/inventory-invention-db.ts); every purchase before that left it at
-- the 0 a save mints, so this backfills the inventions already bought.
--
-- The `invention` table is the `api` worker's (same database). `ModifiedAt` is left alone:
-- being bought is not an edit of the invention.

-- Backs that per-invention count; the primary key leads with account_id.
-- Generated from INVENTORY_INVENTION_SCHEMA_DDL — keep in sync.
CREATE INDEX IF NOT EXISTS idx_inventory_invention_invention
  ON inventory_invention (invention_id);

UPDATE invention
SET data = json_set(
  data,
  '$.NumDownloads',
  (SELECT COUNT(*) FROM inventory_invention WHERE invention_id = invention.id)
)
WHERE id IN (SELECT invention_id FROM inventory_invention);
