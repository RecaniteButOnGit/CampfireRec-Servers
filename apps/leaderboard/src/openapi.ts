import { resolver } from 'hono-openapi'
import { z } from 'zod'

import type { OpenAPIV3_1 } from 'openapi-types'

/**
 * OpenAPI schemas for the leaderboard worker.
 *
 * IMPORTANT: these are DESCRIPTIVE ONLY. They are passed to `describeRoute` to generate
 * the spec and are never wired into `hono-openapi`'s `validator()`. Same rationale as the
 * auth/accounts/econ/match workers: a reverse-engineered protocol, lenient handlers, no
 * runtime validation. Here it matters more than usual — three of the four handlers do not
 * parse their bodies at all, and the fourth reads one field, so a body that contradicts the
 * schema below is still answered.
 *
 * Do NOT add `.meta({ id })` to these schemas — with this hono-openapi + zod v4 setup a
 * meta'd schema used in a response emits a `$ref` the framework doesn't always hoist into
 * `components.schemas`, leaving a dangling reference. Leaving meta off makes every schema
 * inline, which renders correctly in any tool.
 */

/** Emit a zod schema as an `application/json` response body. */
export function json(schema: z.ZodType, description: string) {
	return { description, content: { 'application/json': { schema: resolver(schema) } } }
}

/**
 * Convert a zod schema to a plain OpenAPI schema for a request body. `describeRoute`'s
 * `requestBody` takes an OpenAPI schema (not a `resolver()`). zod's `$schema` key and
 * `additionalProperties: false` are dropped — the handlers ignore fields they don't read,
 * so a closed object would misreport them as stricter than they are.
 */
function toOpenApiSchema(schema: z.ZodType): OpenAPIV3_1.SchemaObject {
	const { $schema: _$schema, additionalProperties: _extra, ...jsonSchema } = z.toJSONSchema(schema)
	return jsonSchema as OpenAPIV3_1.SchemaObject
}

/** An `application/json` request body — every leaderboard route takes one. */
export function jsonBody(schema: z.ZodType, description: string): OpenAPIV3_1.RequestBodyObject {
	return { description, content: { 'application/json': { schema: toOpenApiSchema(schema) } } }
}

// ---- Response schemas ------------------------------------------------------

/**
 * Both leaderboard reads answer this and nothing else: `{ Rows: [...] }`.
 *
 * An EMPTY `Rows` is a complete answer meaning "this leaderboard has no scores", which the
 * client renders as a blank board rather than failing. The key must be present; a bare `{}`
 * trips its parser. Each row is the same `{ PlayerId, Score, Rank }` {@link PlayerRank}
 * answers — the shape both reference servers serve.
 */
export const LeaderboardRows = z.object({
	Rows: z
		.array(z.lazy(() => PlayerRank))
		.describe('The board’s rows, in rank order. Empty when the board has no scores.'),
})

/**
 * `POST /leaderboard/GetPlayerRank` — one player's standing on one board, e.g.
 * `{"PlayerId":205,"Score":4200,"Rank":16}` for the 17th place the client draws.
 *
 * Three fields only: none of the board selectors the request names are echoed back, so the
 * client matches the answer to the question by having asked it. A player with no row gets
 * the 99999 sentinel with a zero score — see the route for why that rather than a rank of
 * 0, which IS first place: the client adds one before it draws.
 */
export const PlayerRank = z.object({
	PlayerId: z.int().describe('Echoed from the request — whose rank this is'),
	Score: z.int().describe('The player’s value on the board; 0 when they have no row there'),
	Rank: z
		.int()
		.describe(
			'0-based position on the board — the client adds one to draw it, so 0 is “#1”; 99999 when the player isn’t on it'
		),
})

/**
 * `POST /leaderboard/CheckAndSetStat` — a BARE JSON number, not an envelope and not a
 * `{ value }` wrapper. The whole body is `0`.
 *
 * What the number means beyond "not an error" hasn't been recovered from the client; `0` is
 * what the live service answers, so it is what this answers.
 */
export const CheckAndSetStatResponse = z
	.literal(0)
	.describe('Always the bare number 0 — the result code the live service returns')

// ---- Request schemas -------------------------------------------------------

/**
 * The board selectors every read carries, in either client shape. A body is the 2026 shape
 * when ANY of `PrimaryKey`/`SecondaryKey`/`LeaderboardType` is present, and its `RoomId` and
 * `StatChannel` are then ignored. Otherwise it is the 2025 shape, read exactly as before.
 *
 * - 2025: `{"PlayerId":205,"StatChannel":1,"RoomId":6,"FilterType":0,"SortAscending":false}`
 * - 2026: `{"PlayerId":205,"PrimaryKey":6,"SecondaryKey":1,"FilterType":0,"SortAscending":false,"LeaderboardType":0}`
 *
 * Same room, same board. In 2026 a null key names no board (an empty answer, not room 0),
 * and an Event board (`LeaderboardType` 1) is always empty because nothing stores event stats.
 */
const BoardSelectors = z.object({
	PlayerId: z.int().describe('The player reading the board, or whose rank is asked for'),
	StatChannel: z.int().optional().describe('≤2025: which of the room’s tracked stats to rank on'),
	RoomId: z.int().optional().describe('≤2025: the room whose board is being read'),
	PrimaryKey: z
		.int()
		.nullable()
		.optional()
		.describe('2026: the room id (`LeaderboardType` 0) or event id (1); null names no board'),
	SecondaryKey: z
		.int()
		.nullable()
		.optional()
		.describe('2026: which of the room’s tracked stats to rank on; null names no board'),
	LeaderboardType: z
		.int()
		.optional()
		.describe('2026: 0 Room, 1 Event (always empty: no event stats are stored)'),
	FilterType: z.int().describe('Who the board counts: 0 Global, 1 Friends'),
	SortAscending: z.boolean().describe('false ranks highest-first, the usual leaderboard'),
})

/**
 * The body the client posts to `GetRanks`: {@link BoardSelectors} plus the slice, e.g.
 * `{"RankStart":0,"RankEnd":9,"PlayerId":2,"StatChannel":1,"RoomId":6,"FilterType":0,"SortAscending":false}`.
 */
export const GetRanksBody = BoardSelectors.extend({
	RankStart: z.int().describe('First rank of the slice, 0-based and inclusive'),
	RankEnd: z.int().describe('Last rank of the slice, inclusive — 0–9 is the first ten'),
})

/** The body the client posts to `GetPlayerRank`: just {@link BoardSelectors}. */
export const GetPlayerRankBody = BoardSelectors

/**
 * The body the client posts to `CheckAndSetStat`, e.g.
 * `{"StatChannel":2,"RoomId":14,"StatValue":1,"CurrentStatValue":null}`.
 *
 * A compare-and-set: `CurrentStatValue` is what the client believes is already stored (null
 * when it believes nothing is), and `StatValue` is what it wants stored. There is no
 * `PlayerId` — the stat belongs to whoever is calling.
 *
 * 20260323 still posts `RoomId` + `StatChannel` here, NOT the reads' `PrimaryKey` /
 * `SecondaryKey`. Keep this model separate from {@link BoardSelectors}.
 */
export const CheckAndSetStatBody = z.object({
	StatChannel: z.int().describe('Which of the room’s tracked stats is being written'),
	RoomId: z.int().describe('The room the stat belongs to'),
	StatValue: z.number().describe('The value to store'),
	CurrentStatValue: z
		.number()
		.nullable()
		.describe('What the client believes is stored now; null when it believes nothing is'),
})

/**
 * The body posted to `GetNearbyScores`: {@link BoardSelectors} plus `WindowSize`, e.g.
 * `{"WindowSize":10,"PlayerId":205,"PrimaryKey":6,"SecondaryKey":1,"FilterType":0,"SortAscending":false,"LeaderboardType":0}`.
 */
export const GetNearbyScoresBody = BoardSelectors.extend({
	WindowSize: z
		.int()
		.describe('How many rows either side of the player to return; default and maximum 10'),
})
