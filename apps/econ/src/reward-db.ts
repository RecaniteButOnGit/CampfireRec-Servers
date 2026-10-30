/**
 * Game-reward eligibility on the shared `recflare` D1 database — one row per (account,
 * reward type, gift context), written by `POST /api/gamerewards/v1/request`.
 *
 * The client asks for a reward whenever it thinks one is due ("First Game of the Day"
 * after an activity, "Activity completed!" after a match), so the server, not the client,
 * has to decide whether one is actually owed: this table is what makes a second ask for
 * the same reward a no-op instead of a second payout.
 *
 * The `giftContext` the client sends (the activity, e.g. `Soccer`) is PART of the key: a
 * cooldown is per (type, activity), so the same activity can't pay twice inside the hour
 * but a different one can. An ask with no context keys on `''` — see `claimReward` for why
 * that isn't NULL.
 *
 * The `econ` worker owns this table and its migrations
 * (apps/econ/migrations/0010_reward_status.sql, widened by
 * apps/econ/migrations/0013_reward_status_gift_context.sql).
 */

/** Schema DDL (mirror of the migrations above) — also builds the table in tests. */
export const REWARD_STATUS_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS reward_status (
		account_id INTEGER NOT NULL,
		reward_type TEXT NOT NULL,
		gift_context TEXT NOT NULL,
		granted_at TEXT NOT NULL,
		grant_count INTEGER NOT NULL,
		PRIMARY KEY (account_id, reward_type, gift_context)
	)`,
]

/**
 * How long a player must wait between rewards of the same type in the same activity: one
 * hour, for every type but `FirstActivityOfDay`, which waits {@link DAILY_REWARD_COOLDOWN_MS}.
 */
export const REWARD_COOLDOWN_MS = 60 * 60 * 1000

/** `FirstActivityOfDay`'s cooldown: a rolling 24h since the player's last one. */
export const DAILY_REWARD_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * The game reward's per-PLAYER daily allowances, each kept in `reward_status` as one row under
 * its reserved type and the empty context: `grant_count` is the AMOUNT paid in the current
 * window (tokens, or XP — not a count of claims) and `granted_at` is when that window opened.
 * The `$` keeps them apart from the client's own type names (`FirstActivityOfDay`,
 * `PostGameActivity`), which a client-sent type could otherwise forge.
 */
export type Allowance = '$tokens' | '$xp'

/**
 * How long an allowance window lasts: a rolling 24h from the first grant in it, rather than a
 * calendar day — so no time zone's midnight decides when a player's allowance comes back.
 */
export const ALLOWANCE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Claim a reward if the player is due one, returning how many of that type they have now
 * claimed in that context — or `null` when the cooldown hasn't elapsed and nothing was
 * claimed.
 *
 * `giftContext` defaults to `''` rather than NULL for the contextless ask: SQLite allows
 * (and does not dedupe) NULLs in a non-INTEGER primary key, so a NULL context would insert
 * a fresh row on every ask instead of hitting the conflict, and the cooldown would never
 * apply.
 *
 * The check and the claim are ONE statement. The client fires these off after a match, so
 * two requests can land together; a read-then-write would let both see the same stale
 * `granted_at` and pay out twice. `ON CONFLICT … DO UPDATE … WHERE` gives us the atomic
 * version: when the cooldown hasn't elapsed the update is skipped, no row is returned, and
 * the stored `granted_at` is left alone (so a rejected claim doesn't extend the cooldown).
 *
 * `granted_at` holds `toISOString()` output — fixed-width UTC, so the lexical `<=` against
 * the cutoff is a chronological comparison with no date parsing in SQL.
 */
export async function claimReward(
	db: D1Database,
	accountId: number,
	rewardType: string,
	giftContext = '',
	now: Date = new Date(),
	cooldownMs: number = REWARD_COOLDOWN_MS
): Promise<number | null> {
	const cutoff = new Date(now.getTime() - cooldownMs).toISOString()
	const row = await db
		.prepare(
			`INSERT INTO reward_status (account_id, reward_type, gift_context, granted_at, grant_count)
			 VALUES (?1, ?2, ?3, ?4, 1)
			 ON CONFLICT (account_id, reward_type, gift_context) DO UPDATE SET
			   granted_at = excluded.granted_at,
			   grant_count = reward_status.grant_count + 1
			 WHERE reward_status.granted_at <= ?5
			 RETURNING grant_count`
		)
		.bind(accountId, rewardType, giftContext, now.toISOString(), cutoff)
		.first<{ grant_count: number }>()
	return row?.grant_count ?? null
}

/**
 * Add `amount` to the player's daily `allowance` if it fits under `cap`, returning the
 * window's new total — or `null` when it doesn't fit and nothing was granted.
 *
 * A window older than {@link ALLOWANCE_WINDOW_MS} is reset in place (the row's key allows
 * one per player): `granted_at` moves to now and the total restarts at `amount`. Otherwise the
 * amount is added to the running total, and `granted_at` is left alone so the window keeps its
 * start. All grant-or-nothing: a claim that would cross the cap pays nothing rather than the
 * remainder, so `cap` should be a multiple of `amount`.
 *
 * One statement, for the same reason as {@link claimReward}: asks landing together can't both
 * read a total under the cap and both pay. SQLite evaluates every `SET` against the row as it
 * was, so both `CASE`s see the old `granted_at`.
 */
export async function claimAllowance(
	db: D1Database,
	accountId: number,
	allowance: Allowance,
	amount: number,
	cap: number,
	now: Date = new Date()
): Promise<number | null> {
	if (amount > cap) return null
	const cutoff = new Date(now.getTime() - ALLOWANCE_WINDOW_MS).toISOString()
	const row = await db
		.prepare(
			`INSERT INTO reward_status (account_id, reward_type, gift_context, granted_at, grant_count)
			 VALUES (?1, ?2, '', ?3, ?4)
			 ON CONFLICT (account_id, reward_type, gift_context) DO UPDATE SET
			   granted_at = CASE WHEN reward_status.granted_at <= ?5
			     THEN excluded.granted_at ELSE reward_status.granted_at END,
			   grant_count = CASE WHEN reward_status.granted_at <= ?5
			     THEN ?4 ELSE reward_status.grant_count + ?4 END
			 WHERE reward_status.granted_at <= ?5 OR reward_status.grant_count + ?4 <= ?6
			 RETURNING grant_count`
		)
		.bind(accountId, allowance, now.toISOString(), amount, cutoff, cap)
		.first<{ grant_count: number }>()
	return row?.grant_count ?? null
}
