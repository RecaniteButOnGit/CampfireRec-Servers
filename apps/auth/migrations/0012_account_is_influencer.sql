-- Expose the account's influencer flag (`isInfluencer` in the JSON blob) as an indexed
-- generated column, so "every influencer" is an index walk rather than a scan of every
-- account's JSON. The reader is econ's `GET /api/influencerpartnerprogram/influencers`,
-- which the client asks for the whole list on every launch so it can badge influencers
-- wherever they turn up.
--
-- Same construction as `has_plus` (0009): a PARTIAL index holding only the rows where the
-- flag is set, so it is as small as the influencer list. A query must say exactly
-- `is_influencer = 1` to use it. `json_extract` yields 1 for JSON true, 0 for false and
-- NULL when the key is absent, so neither a revoked nor a never-granted account is in it.
-- Kept in sync with SCHEMA_DDL in @repo/domain's accounts-db.ts (and its mirror in
-- apps/econ/src/avatar-db.ts).

ALTER TABLE account ADD COLUMN is_influencer INTEGER GENERATED ALWAYS AS (json_extract(data, '$.isInfluencer')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_account_is_influencer ON account (is_influencer) WHERE is_influencer = 1;
