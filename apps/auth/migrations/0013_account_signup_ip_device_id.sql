-- Expose the account's `signupIp` and `deviceId` (both in the JSON blob) as indexed
-- generated columns, so the signup caps (`countAccountsBySignupIp`,
-- `countAccountsByDeviceId` in @repo/domain's accounts-db.ts) are an index lookup
-- instead of running json_extract over every account. The IP count alone was a third
-- of D1's query time, and both run on every account creation.
--
-- Same construction as `has_plus` (0009) and `is_influencer` (0012), but a full index
-- rather than a partial one: the lookup is by value, not by a fixed flag. Kept in sync
-- with SCHEMA_DDL in @repo/domain's accounts-db.ts (and its mirror in
-- apps/econ/src/avatar-db.ts).

ALTER TABLE account ADD COLUMN signup_ip TEXT GENERATED ALWAYS AS (json_extract(data, '$.signupIp')) VIRTUAL;
ALTER TABLE account ADD COLUMN device_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.deviceId')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_account_signup_ip ON account (signup_ip);
CREATE INDEX IF NOT EXISTS idx_account_device_id ON account (device_id);
