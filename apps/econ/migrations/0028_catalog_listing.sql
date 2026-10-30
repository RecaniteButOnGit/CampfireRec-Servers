-- The served store listing behind a catalog row, verbatim as JSON: the `StoreItems[]` entry
-- of `static/storefronts/sf3-2025.json` whose `PurchasableItemId` is the row's `catalog_id`.
--
-- `POST /api/storefronts/v1/purchasableitems` answers with whole listings — prices, item set,
-- `AvatarItemInfo` and the rest — which the catalog's own columns do not carry. Keeping the
-- listing on the row lets that lookup be one indexed query instead of fetching and parsing the
-- 4 MB storefront file per request.
--
-- Filled by `runx catalog load`, like every other column. NULL on a row the served store does
-- not list (the same rows whose `catalog_id` is NULL), and until the first load after this
-- migration.
--
-- Its own migration because 0015 and 0016 are already applied.

ALTER TABLE catalog ADD COLUMN listing TEXT;
