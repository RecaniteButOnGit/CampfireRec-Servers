/**
 * The `link` table (migrations/0001_link.sql): one row per share code minted by
 * `POST /actionlink`.
 */

/**
 * The code alphabet: upper-case letters and digits without the look-alikes (0/O, 1/I/L),
 * since a player may read a code aloud or type it from a screenshot. 31 symbols, so six of
 * them give ~887 million codes.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6

/** How many fresh codes to try before giving up on a run of collisions. */
const MAX_ATTEMPTS = 8

/** A random code. Rejection-sampled so every symbol is equally likely. */
export function randomCode(): string {
	// The largest multiple of the alphabet size that fits in a byte.
	const limit = 256 - (256 % CODE_ALPHABET.length)
	let code = ''
	while (code.length < CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
			if (byte >= limit) continue
			code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
			if (code.length === CODE_LENGTH) break
		}
	}
	return code
}

export interface NewLink {
	creatorAccountId: number
	codeType: number
	extraDataId: number | null
	data: string | null
	validHours: number
}

export interface LinkRow {
	code: string
	creator_account_id: number
	code_type: number
	extra_data_id: number | null
	data: string | null
	valid_hours: number
	created_at: string
	expires_at: string
}

/**
 * Store a link under a fresh code and return the code. A code already taken is skipped
 * (`ON CONFLICT DO NOTHING` returns no row) and another drawn.
 */
export async function createLink(db: D1Database, link: NewLink, now = new Date()): Promise<string> {
	const createdAt = now.toISOString()
	const expiresAt = new Date(now.getTime() + link.validHours * 3_600_000).toISOString()
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const code = randomCode()
		const row = await db
			.prepare(
				`INSERT INTO link (code, creator_account_id, code_type, extra_data_id, data, valid_hours, created_at, expires_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
				 ON CONFLICT (code) DO NOTHING
				 RETURNING code`
			)
			.bind(
				code,
				link.creatorAccountId,
				link.codeType,
				link.extraDataId,
				link.data,
				link.validHours,
				createdAt,
				expiresAt
			)
			.first<{ code: string }>()
		if (row) return row.code
	}
	throw new Error(`no free link code after ${MAX_ATTEMPTS} attempts`)
}

/** One link by code, or null. */
export async function getLink(db: D1Database, code: string): Promise<LinkRow | null> {
	return db.prepare('SELECT * FROM link WHERE code = ?1').bind(code).first<LinkRow>()
}
