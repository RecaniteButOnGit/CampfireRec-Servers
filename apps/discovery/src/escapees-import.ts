import {
	countRoomsByCreator,
	getAccountByUsername,
	getRoomByName,
	importRoom,
	RoomTagType,
} from '@repo/domain'

import { authorizedToken, parseEnvelope, parseFields } from './ai-request'
import { buildEscapeesRoomAsync } from './escapees-room'
import { decodeEscapeesSnapshot } from './escapees-snapshot'

import type { App } from './context'

const IMPORT_FIELDS = new Set(['Map', 'User', 'Password', 'RRUser'])
const PROGRESS_FIELDS = new Set(['Map'])
const MAP_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_ROOMS = 20
const ESCAPEES_API = 'https://api.escapees.net'

type Env = App['Bindings']
type Job = {
	map_id: string
	job_id: string
	rr_account_id: number
	room_name: string
	description: string
	snapshot_key: string
	state: 'queued' | 'running' | 'done' | 'error'
	progress: number
	error: string | null
	room_id: number | null
}

class ImportFailure extends Error {}

/** CV2 page-source chips read the text from id/sourceMetadata. */
export function importResponse(value: string) {
	return [
		{
			id: value,
			sectionType: 13,
			sectionSubType: 'EscapeesImportResponse',
			source: 'PageSource',
			sourceMetadata: value,
			displayMetadata: JSON.stringify({ DisplayTitle: value }),
		},
	]
}

function friendly(error: unknown): string {
	return error instanceof ImportFailure ? error.message : 'The import failed. Please try again.'
}

function maxRooms(env: Env): number {
	if (env.MAX_ROOMS_PER_ACCOUNT === undefined || env.MAX_ROOMS_PER_ACCOUNT === '')
		return DEFAULT_MAX_ROOMS
	const raw = Number(env.MAX_ROOMS_PER_ACCOUNT)
	return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MAX_ROOMS
}

function fromBase64(value: string): Uint8Array {
	if (
		!value ||
		value.length > Math.ceil((MAX_SNAPSHOT_BYTES * 4) / 3) + 4 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
		value.length % 4 !== 0
	) {
		throw new ImportFailure('The Escapees map save is invalid or too large.')
	}
	let binary: string
	try {
		binary = atob(value)
	} catch {
		throw new ImportFailure('The Escapees map save is invalid.')
	}
	if (!binary.length || binary.length > MAX_SNAPSHOT_BYTES) {
		throw new ImportFailure('The Escapees map save is invalid or too large.')
	}
	return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function escapeesJson(
	url: string,
	init?: RequestInit
): Promise<{ response: Response; body: Record<string, unknown> }> {
	let response: Response
	try {
		response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), cache: 'no-store' })
	} catch {
		throw new ImportFailure('Escapees is unavailable right now. Please try again.')
	}
	let body: unknown
	try {
		body = await response.json()
	} catch {
		body = null
	}
	return {
		response,
		body:
			body && typeof body === 'object' && !Array.isArray(body)
				? (body as Record<string, unknown>)
				: {},
	}
}

async function fetchOwnedMap(env: Env, mapId: string, user: string, password: string) {
	const base = (env.ESCAPEES_API_URL || ESCAPEES_API).replace(/\/+$/, '')
	const login = await escapeesJson(`${base}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: user, password }),
	})
	if (login.response.status === 401 || login.response.status === 403) {
		throw new ImportFailure('The Escapees username or password is incorrect.')
	}
	if (!login.response.ok)
		throw new ImportFailure('Escapees could not sign you in right now. Please try again.')
	const session = login.body.session as { token?: unknown } | undefined
	const token = session?.token
	if (typeof token !== 'string' || !token)
		throw new ImportFailure('Escapees did not return a login session.')
	const headers = { Authorization: `Bearer ${token}` }
	try {
		const lookup = await escapeesJson(`${base}/maps/${encodeURIComponent(mapId)}`, { headers })
		if (lookup.response.status === 404) throw new ImportFailure('That Escapees map does not exist.')
		if (lookup.response.status === 403)
			throw new ImportFailure('You must own the Escapees map to import it.')
		if (!lookup.response.ok)
			throw new ImportFailure('Escapees could not check map ownership right now.')
		const map = lookup.body.map as
			{ role?: unknown; mapId?: unknown; description?: unknown } | undefined
		if (map?.role !== 'owner' || map.mapId !== mapId) {
			throw new ImportFailure('You must own the Escapees map to import it.')
		}
		let content = await escapeesJson(
			`${base}/maps/${encodeURIComponent(mapId)}/content?revision=working`,
			{ headers }
		)
		if (content.response.status === 404) {
			content = await escapeesJson(
				`${base}/maps/${encodeURIComponent(mapId)}/content?revision=live`,
				{ headers }
			)
		}
		if (content.response.status === 404)
			throw new ImportFailure('This map has no saved volumes yet.')
		if (!content.response.ok || typeof content.body.snapshot !== 'string') {
			throw new ImportFailure('Escapees could not download this map right now.')
		}
		return {
			snapshot: fromBase64(content.body.snapshot),
			description: typeof map.description === 'string' ? map.description.slice(0, 1000) : '',
		}
	} finally {
		// The snapshot is now in Campfire Rec's hands; do not leave a new 30-day session behind.
		await fetch(`${base}/auth/logout`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(2_000),
		}).catch(() => {})
	}
}

async function readJob(db: D1Database, mapId: string): Promise<Job | null> {
	return db.prepare('SELECT * FROM escapees_import_job WHERE map_id = ?1').bind(mapId).first<Job>()
}

async function progress(db: D1Database, job: Job, value: number): Promise<void> {
	await db
		.prepare(
			"UPDATE escapees_import_job SET progress = ?3, updated_at = ?4 WHERE map_id = ?1 AND job_id = ?2 AND state = 'running'"
		)
		.bind(job.map_id, job.job_id, value, new Date().toISOString())
		.run()
}

async function failJob(env: Env, job: Job, error: unknown): Promise<void> {
	await env.DB.prepare(
		"UPDATE escapees_import_job SET state = 'error', error = ?3, updated_at = ?4 WHERE map_id = ?1 AND job_id = ?2"
	)
		.bind(job.map_id, job.job_id, friendly(error), new Date().toISOString())
		.run()
}

/** Claim a queued or stale job. Cron can recover a Worker that ended mid-import. */
export async function runEscapeesImport(env: Env, mapId: string, jobId: string): Promise<void> {
	const stale = new Date(Date.now() - 2 * 60_000).toISOString()
	const claim = await env.DB.prepare(
		"UPDATE escapees_import_job SET state = 'running', updated_at = ?3 WHERE map_id = ?1 AND job_id = ?2 AND (state = 'queued' OR (state = 'running' AND updated_at < ?4))"
	)
		.bind(mapId, jobId, new Date().toISOString(), stale)
		.run()
	if (!claim.meta.changes) return
	const job = await readJob(env.DB, mapId)
	if (!job || job.job_id !== jobId) return
	let sceneKey: string | null = null
	let roomCreated = false
	let terminal = false
	try {
		// If room creation succeeded before the Worker was interrupted, finish the job.
		const existing = await getRoomByName(env.DB, job.room_name)
		if (existing && existing.CreatorAccountId === job.rr_account_id) {
			await env.DB.prepare(
				"UPDATE escapees_import_job SET state = 'done', progress = 100, room_id = ?3, updated_at = ?4 WHERE map_id = ?1 AND job_id = ?2"
			)
				.bind(mapId, jobId, existing.RoomId, new Date().toISOString())
				.run()
			terminal = true
			return
		}
		const snapshot = await env.CDN_ASSETS.get(job.snapshot_key)
		if (!snapshot)
			throw new ImportFailure('The saved map could not be read. Please try importing again.')
		let volumes: ReturnType<typeof decodeEscapeesSnapshot>
		try {
			volumes = decodeEscapeesSnapshot(new Uint8Array(await snapshot.arrayBuffer()))
		} catch (error) {
			throw new ImportFailure(
				error instanceof Error && /^(The|This) Escapees map/.test(error.message)
					? error.message
					: 'The Escapees map save could not be read.'
			)
		}
		await progress(env.DB, job, 20)
		const starter = await env.ASSETS.fetch(
			new Request('https://discovery.recflare.net/escapees-base.room')
		)
		if (!starter.ok) throw new ImportFailure('The room template is unavailable right now.')
		const roomBytes = await buildEscapeesRoomAsync(
			new Uint8Array(await starter.arrayBuffer()),
			volumes,
			(fraction) => progress(env.DB, job, 20 + Math.round(50 * fraction))
		)
		const account = await env.DB.prepare('SELECT account_id FROM account WHERE account_id = ?1')
			.bind(job.rr_account_id)
			.first()
		if (!account) throw new ImportFailure('The Campfire Rec account no longer exists.')
		const cap = maxRooms(env)
		if (cap > 0 && (await countRoomsByCreator(env.DB, job.rr_account_id)) >= cap) {
			throw new ImportFailure(`That Campfire Rec account has reached its ${cap}-room limit.`)
		}
		if (await getRoomByName(env.DB, job.room_name)) {
			throw new ImportFailure('The room name is already in use. Please try importing again.')
		}
		const hashInput = new Uint8Array(roomBytes.length)
		hashInput.set(roomBytes)
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', hashInput.buffer))
		const hashBase64 = btoa(Array.from(hash, (byte) => String.fromCharCode(byte)).join(''))
		sceneKey = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`
		await env.CDN_ASSETS.put(`room/${sceneKey}`, roomBytes, {
			httpMetadata: { contentType: 'application/octet-stream' },
		})
		await progress(env.DB, job, 85)
		const room = await importRoom(
			env.DB,
			{
				Name: job.room_name,
				Description: job.description || `Imported from Escapees map ${mapId}.`,
				UgcVersion: 1,
				Tags: [{ Tag: 'limitsv2', Type: RoomTagType.auto }],
			},
			'',
			[
				{
					details: { Name: 'Main', UnitySceneId: 'a75f7547-79eb-47c6-8986-6767abcb4f92' },
					save: { PersistenceVersion: 179, OMVersion: 0, UgcSubVersion: 0 },
					dataBlob: sceneKey,
					dataBlobHash: hashBase64,
				},
			],
			job.rr_account_id
		)
		roomCreated = true
		await env.DB.prepare(
			"UPDATE escapees_import_job SET state = 'done', progress = 100, room_id = ?3, updated_at = ?4 WHERE map_id = ?1 AND job_id = ?2"
		)
			.bind(mapId, jobId, room.RoomId, new Date().toISOString())
			.run()
		terminal = true
	} catch (error) {
		if (sceneKey && !roomCreated) await env.CDN_ASSETS.delete(`room/${sceneKey}`).catch(() => {})
		if (!roomCreated) {
			await failJob(env, job, error)
			terminal = true
		}
	} finally {
		if (terminal) await env.CDN_ASSETS.delete(job.snapshot_key).catch(() => {})
	}
}

export async function startEscapeesImport(
	value: string,
	env: Env,
	waitUntil: (task: Promise<unknown>) => void
): Promise<string> {
	const envelope = parseEnvelope(value, 'EscapeesImport[')
	if (!envelope || !(await authorizedToken(envelope.token, env)))
		return 'Error:The import key is missing or incorrect.'
	const fields = parseFields(envelope.body, IMPORT_FIELDS)
	if (!fields)
		return 'Error:Check the import format: Map:"...",User:"...",Password:"...",RRUser:"...".'
	const mapId = fields?.Map?.trim().toLowerCase()
	const user = fields?.User?.trim()
	const password = fields?.Password
	const rrUser = fields?.RRUser?.trim()
	if (!mapId || !MAP_ID.test(mapId) || mapId.length > 80)
		return 'Error:Enter a valid Escapees map ID, such as "lobby".'
	if (!user || user.length > 80) return 'Error:Enter your Escapees username.'
	if (!password || password.length > 128) return 'Error:Enter your Escapees password.'
	if (!rrUser || rrUser.length > 80) return 'Error:Enter your Campfire Rec username.'
	try {
		if (!env.DB || !env.CDN_ASSETS)
			throw new ImportFailure('Map imports are unavailable right now.')
		const account = await getAccountByUsername(env.DB, rrUser)
		if (!account) throw new ImportFailure('That Campfire Rec user was not found.')
		const accountId = account.accountId
		const cap = maxRooms(env)
		const roomCount = await countRoomsByCreator(env.DB, accountId)
		const pending =
			cap > 0
				? await env.DB.prepare(
						"SELECT COUNT(*) AS count FROM escapees_import_job WHERE rr_account_id = ?1 AND state IN ('queued', 'running')"
					)
						.bind(accountId)
						.first<{ count: number }>()
				: null
		if (cap > 0 && roomCount + (pending?.count ?? 0) >= cap) {
			throw new ImportFailure(`That Campfire Rec user has reached the ${cap}-room limit.`)
		}
		const busy = await readJob(env.DB, mapId)
		if (busy && (busy.state === 'queued' || busy.state === 'running')) {
			throw new ImportFailure('This Escapees map is already being imported.')
		}
		const map = await fetchOwnedMap(env, mapId, user, password)
		const jobId = crypto.randomUUID()
		const roomName = `Escapees_${mapId.slice(0, 12)}_${jobId.slice(0, 8)}`
		const snapshotKey = `escapees-import/${jobId}/snapshot`
		await env.CDN_ASSETS.put(snapshotKey, map.snapshot)
		try {
			const saved = await env.DB.prepare(
				`INSERT INTO escapees_import_job
				 (map_id, job_id, rr_account_id, room_name, description, snapshot_key, state, progress, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, ?7)
				 ON CONFLICT(map_id) DO UPDATE SET
				 job_id=excluded.job_id, rr_account_id=excluded.rr_account_id,
				 room_name=excluded.room_name, description=excluded.description,
				 snapshot_key=excluded.snapshot_key, state='queued', progress=0,
				 error=NULL, room_id=NULL, updated_at=excluded.updated_at
				 WHERE escapees_import_job.state IN ('done', 'error')`
			)
				.bind(
					mapId,
					jobId,
					accountId,
					roomName,
					map.description,
					snapshotKey,
					new Date().toISOString()
				)
				.run()
			if (!saved.meta.changes)
				throw new ImportFailure('This Escapees map is already being imported.')
		} catch (error) {
			await env.CDN_ASSETS.delete(snapshotKey).catch(() => {})
			throw error
		}
		waitUntil(runEscapeesImport(env, mapId, jobId))
		return 'received'
	} catch (error) {
		return `Error:${friendly(error)}`
	}
}

export async function escapeesImportProgress(value: string, env: Env): Promise<string> {
	const envelope = parseEnvelope(value, 'EscapeesImportProgress[')
	if (!envelope || !(await authorizedToken(envelope.token, env)))
		return 'Error:The import key is missing or incorrect.'
	const fields = parseFields(envelope.body, PROGRESS_FIELDS)
	if (!fields) return 'Error:Check the progress format: Map:"lobby".'
	const mapId = fields?.Map?.trim().toLowerCase()
	if (!mapId || !MAP_ID.test(mapId) || mapId.length > 80)
		return 'Error:Enter a valid Escapees map ID.'
	try {
		const job = await readJob(env.DB, mapId)
		if (!job) return 'Error:No import was found for that map.'
		if (job.state === 'done') return 'done'
		if (job.state === 'error') return `Error:${job.error || 'The import failed. Please try again.'}`
		return String(job.progress)
	} catch {
		return 'Error:Import progress is unavailable right now.'
	}
}

/** One recovery per cron tick limits heavy conversions on both Workers and Railway. */
export async function resumeEscapeesImports(env: Env): Promise<void> {
	const stale = new Date(Date.now() - 2 * 60_000).toISOString()
	const job = await env.DB.prepare(
		"SELECT * FROM escapees_import_job WHERE state = 'queued' OR (state = 'running' AND updated_at < ?1) ORDER BY updated_at LIMIT 1"
	)
		.bind(stale)
		.first<Job>()
	if (job) await runEscapeesImport(env, job.map_id, job.job_id)
}
