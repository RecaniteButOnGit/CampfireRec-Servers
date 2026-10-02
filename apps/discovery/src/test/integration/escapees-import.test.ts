import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { deflateSync } from 'fflate'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SCHEMA_DDL as ACCOUNT_SCHEMA_DDL, ROOM_SCHEMA_DDL, SUBROOM_SCHEMA_DDL } from '@repo/domain'

import { app } from '../../discovery.app'
import { buildEscapeesRoom } from '../../escapees-room'
import { decodeEscapeesSnapshot } from '../../escapees-snapshot'

const TOKEN = 'import-test-key'
const RR_ACCOUNT_ID = 81001

function u16(value: number) {
	return [value & 255, (value >> 8) & 255]
}
function i32(value: number) {
	return [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255]
}
function packedSize(x: number, y: number, z: number) {
	const packed = x + y * 2 ** 11 + z * 2 ** 22
	return Array.from({ length: 5 }, (_, i) => Math.floor(packed / 2 ** (8 * i)) & 255)
}

function snapshot(): Uint8Array {
	const payload = Uint8Array.from([
		...i32(3),
		1,
		0,
		1 << 3,
		...u16(0),
		...u16(0),
		...u16(0),
		...packedSize(10, 20, 30),
		1,
		1,
		...u16(0),
		...u16(0),
		...u16(0),
		1,
		0,
		(2 << 3) | 1,
		...u16(20),
		...u16(0),
		...u16(0),
		...packedSize(10, 10, 10),
	])
	const compressed = deflateSync(payload)
	return Uint8Array.from([3, 1, ...i32(payload.length), ...compressed])
}

function readFields(bytes: Uint8Array) {
	const fields: Array<{ number: number; value: number | Uint8Array }> = []
	let index = 0
	const readVarint = () => {
		let value = 0
		let shift = 0
		while (true) {
			const next = bytes[index++]!
			value += (next & 127) * 2 ** shift
			if (!(next & 128)) return value
			shift += 7
		}
	}
	while (index < bytes.length) {
		const key = readVarint()
		const wire = key & 7
		const number = key >> 3
		if (wire === 0) fields.push({ number, value: readVarint() })
		else if (wire === 2) {
			const length = readVarint()
			fields.push({ number, value: bytes.subarray(index, index + length) })
			index += length
		} else if (wire === 5) index += 4
		else throw new Error(`Unexpected wire type ${wire}`)
	}
	return fields
}

function field(bytes: Uint8Array, number: number): Uint8Array {
	return readFields(bytes).find((item) => item.number === number)?.value as Uint8Array
}

function command(name: string, fields: string): string {
	return `${name}[${fields}]8254TOKEN${JSON.stringify(TOKEN)}`
}

async function call(value: string, cap = 20) {
	const context = createExecutionContext()
	const response = await app.fetch(
		new Request(`https://discovery.example.com/sections/pagesource/${encodeURIComponent(value)}`),
		{ ...env, RRTOKEN: { get: async () => TOKEN }, MAX_ROOMS_PER_ACCOUNT: cap } as never,
		context
	)
	const body = (await response.json()) as Array<{ id: string }>
	return { response, body, context }
}

beforeAll(async () => {
	for (const ddl of ACCOUNT_SCHEMA_DDL) await env.DB.prepare(ddl).run()
	for (const ddl of ROOM_SCHEMA_DDL) await env.DB.prepare(ddl).run()
	for (const ddl of SUBROOM_SCHEMA_DDL) await env.DB.prepare(ddl).run()
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS escapees_import_job (
		map_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, rr_account_id INTEGER NOT NULL,
		room_name TEXT NOT NULL, description TEXT NOT NULL, snapshot_key TEXT NOT NULL,
		state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, error TEXT,
		room_id INTEGER, updated_at TEXT NOT NULL
	)`
	).run()
	await env.DB.prepare('INSERT INTO account (data) VALUES (?1)')
		.bind(JSON.stringify({ accountId: RR_ACCOUNT_ID, username: 'ImportTester' }))
		.run()
})

afterEach(() => vi.restoreAllMocks())

describe('Escapees CV2 import', () => {
	it('decodes a compressed Escapees v3 snapshot and writes simple RR box and sphere views', () => {
		const volumes = decodeEscapeesSnapshot(snapshot())
		expect(volumes).toEqual([
			{ shape: 'box', origin: [0, 0, 0], size: [1, 2, 3], colorIndex: 1, material: 0 },
			{ shape: 'ball', origin: [2, 0, 0], size: [1, 1, 1], colorIndex: 2, material: 0 },
		])
		const room = buildEscapeesRoom(new Uint8Array(), volumes)
		const views = readFields(room)
			.filter((item) => item.number === 2)
			.map((item) => item.value as Uint8Array)
		expect(views).toHaveLength(2)
		const shapeTypes = views.map((view) => {
			const container = field(view, 12)
			const collection = field(container, 1)
			const shape = field(collection, 1)
			return readFields(shape).find((item) => item.number === 1)?.value
		})
		expect(shapeTypes).toEqual([8, 3])
	})

	it('returns a friendly ownership error before queueing work', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input)
			if (url.endsWith('/auth/login'))
				return Response.json({ session: { token: 'escapees-session' } })
			if (url.includes('/maps/'))
				return Response.json({ map: { role: 'player', mapId: 'not_mine' } })
			return Response.json({ ok: true })
		})
		const result = await call(
			command(
				'EscapeesImport',
				'Map:"not_mine",User:"escapees",Password:"secret123",RRUser:"ImportTester"'
			)
		)
		expect(result.body[0]?.id).toBe('Error:You must own the Escapees map to import it.')
		expect(
			await env.DB.prepare('SELECT * FROM escapees_import_job WHERE map_id = ?1')
				.bind('not_mine')
				.first()
		).toBeNull()
	})

	it('returns friendly login and room-limit errors before queueing work', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({ error: 'Invalid username or password.' }, { status: 401 })
		)
		const request = command(
			'EscapeesImport',
			'Map:"login_failure",User:"escapees",Password:"wrong",RRUser:"ImportTester"'
		)
		const login = await call(request)
		expect(login.body[0]?.id).toBe('Error:The Escapees username or password is incorrect.')
		await env.DB.prepare('INSERT INTO room (data) VALUES (?1)')
			.bind(
				JSON.stringify({
					RoomId: 81002,
					Name: 'ExistingRoom',
					CreatorAccountId: RR_ACCOUNT_ID,
					IsDorm: false,
				})
			)
			.run()
		try {
			const limit = await call(request, 1)
			expect(limit.body[0]?.id).toBe('Error:That Campfire Rec user has reached the 1-room limit.')
		} finally {
			await env.DB.prepare('DELETE FROM room WHERE room_id = ?1').bind(81002).run()
		}
		const job = await env.DB.prepare('SELECT * FROM escapees_import_job WHERE map_id = ?1')
			.bind('login_failure')
			.first()
		expect(job).toBeNull()
	})

	it('reports a readable error through progress if a saved map is corrupt', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input)
			if (url.endsWith('/auth/login'))
				return Response.json({ session: { token: 'escapees-session' } })
			if (url.endsWith('/maps/corrupt_map'))
				return Response.json({ map: { role: 'owner', mapId: 'corrupt_map' } })
			if (url.includes('/maps/corrupt_map/content'))
				return Response.json({ snapshot: btoa(String.fromCharCode(9, 0, 0, 0)) })
			return Response.json({ ok: true })
		})
		const started = await call(
			command(
				'EscapeesImport',
				'Map:"corrupt_map",User:"escapees",Password:"secret123",RRUser:"ImportTester"'
			)
		)
		expect(started.body[0]?.id).toBe('received')
		await waitOnExecutionContext(started.context)
		const status = await call(command('EscapeesImportProgress', 'Map:"corrupt_map"'))
		expect(status.body[0]?.id).toBe('Error:This Escapees map save version is not supported.')
	})

	it('returns received, finishes in the background, and reports done only after room creation', async () => {
		const bytes = snapshot()
		const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input)
			if (url.endsWith('/auth/login'))
				return Response.json({ session: { token: 'escapees-session' } })
			if (url.endsWith('/maps/owned_map'))
				return Response.json({
					map: { role: 'owner', mapId: 'owned_map', description: 'A test map' },
				})
			if (url.includes('/maps/owned_map/content')) return Response.json({ snapshot: base64 })
			return Response.json({ ok: true })
		})
		const result = await call(
			command(
				'EscapeesImport',
				'Map:"owned_map",User:"escapees",Password:"secret123",RRUser:"ImportTester"'
			)
		)
		expect(result.body[0]?.id).toBe('received')
		await waitOnExecutionContext(result.context)
		const progress = await call(command('EscapeesImportProgress', 'Map:"owned_map"'))
		expect(progress.body[0]?.id).toBe('done')
		const job = await env.DB.prepare('SELECT * FROM escapees_import_job WHERE map_id = ?1')
			.bind('owned_map')
			.first<{ room_id: number; rr_account_id: number }>()
		expect(job?.rr_account_id).toBe(RR_ACCOUNT_ID)
		const room = await env.DB.prepare('SELECT data FROM room WHERE room_id = ?1')
			.bind(job!.room_id)
			.first<{ data: string }>()
		expect(JSON.parse(room!.data)).toMatchObject({
			CreatorAccountId: RR_ACCOUNT_ID,
			Accessibility: 0,
		})
	})
})
