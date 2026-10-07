import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendSubRoomSaveIfLatest, ROOM_SCHEMA_DDL, SUBROOM_SCHEMA_DDL } from '@repo/domain'

import { resumeCV2Agents } from '../../discovery/src/cv2-agent'
import { runAgent } from '../../discovery/src/cv2-agent/agent'
import { parse, serialize } from '../../discovery/src/cv2-agent/language'
import {
	decode,
	fields,
	guid,
	join,
	nodeType,
	roomType,
	stable,
	update,
} from '../../discovery/src/cv2-agent/protobuf'
import { getCv2DefinitionRegistry } from '../../discovery/src/cv2-agent/registry'
import { equalBytes, RoomDocument } from '../../discovery/src/cv2-agent/room'
import { commitSave, saveComment, snapshot } from '../../discovery/src/cv2-agent/saves'
import { RoomWorkspace } from '../../discovery/src/cv2-agent/workspace'
import { app } from '../../discovery/src/discovery.app'
import { SQLiteD1 } from './d1-adapter'
import { NodeExecutionContext } from './execution-context'

import type { Env } from '../../discovery/src/context'

const ids = {
	graph: '10'.repeat(16),
	child: '20'.repeat(16),
	source: '30'.repeat(16),
	target: '40'.repeat(16),
	other: '50'.repeat(16),
	sourceType: '60'.repeat(16),
	targetType: '70'.repeat(16),
}
function node(key: string, source: boolean, value = 5) {
	return {
		node_id: guid(key),
		node_type: guid(source ? ids.sourceType : ids.targetType),
		node_name: source ? 'Delay' : 'Sink',
		transform_data: { local_position: { x: 3, y: 2, z: 1 } },
		node_groups: [
			{
				inputs: [{ default_signal_value: { DEPRECATED_backing_float: source ? value : 0 } }],
				first_input_indices: [0],
			},
		],
		...(source
			? {
					event_receiver_node_data: {
						node_desc: {
							name: 'Test source',
							inputs: [{ name: 'Duration', type: { kind: 'Single' } }],
							outputs: [{ name: 'Value', type: { kind: 'Single' } }],
						},
					},
				}
			: {
					out_node_data: {
						node_desc: { name: 'Test sink', inputs: [{ name: 'Value', type: { kind: 'Single' } }] },
					},
				}),
	}
}
function save(options: { entities?: boolean; nested?: boolean } = {}) {
	const graph = {
		graph_id: guid(ids.graph),
		node_datas: [
			node(ids.source, true),
			node(ids.target, false),
			{ ...node(ids.other, true), node_name: 'Unrelated' },
		],
		edges: [{ src_node_id: guid(ids.source), dst_node_id: guid(ids.target) }],
		...(options.nested
			? {
					child_graphs: [
						{ graph_id: guid(ids.child), node_datas: [node('80'.repeat(16), true)], edges: [] },
					],
				}
			: {}),
	}
	return join([
		roomType
			.encode(
				roomType.fromObject({
					version: 'V179InventionPieceObjectID',
					activity_id: 'untouched geometry metadata',
					circuit_v2_data: {
						version: 'V34InteractionFilterToggle',
						root: graph,
						...(options.entities ? { entities: {} } : {}),
					},
				})
			)
			.finish(),
		Uint8Array.from([0xc0, 0x3e, 0x87, 0x00]),
	])
}
function workspace(bytes = save()) {
	return new RoomWorkspace(new RoomDocument(bytes))
}
function sourcePath(ws: RoomWorkspace) {
	return [...ws.files].find(([, file]) =>
		file.script.nodes.some((node) => node.id === ids.source)
	)![0]
}
function changeValue(ws: RoomWorkspace, value: number, key = ids.source) {
	const [path, file] = [...ws.files].find(([, file]) =>
		file.script.nodes.some((node) => node.id === key)
	)!
	ws.patch(path, file.revision, [
		{ old: '"DEPRECATED_backing_float":5', new: `"DEPRECATED_backing_float":${value}` },
	])
	return path
}
afterEach(() => vi.restoreAllMocks())

describe('lossless CV2 compiler', () => {
	it('decompiles deterministically into disconnected components and round trips every byte', () => {
		const bytes = save({ nested: true }),
			a = workspace(bytes),
			b = workspace(bytes)
		expect([...a.files].map(([path, file]) => [path, file.text])).toEqual(
			[...b.files].map(([path, file]) => [path, file.text])
		)
		expect(a.files.size).toBe(3)
		expect(a.knownReferences.has(ids.source)).toBe(true)
		expect(a.compile().bytes).toEqual(bytes)
		for (const [path, file] of a.files) expect(serialize(parse(file.text, path))).toBe(file.text)
	})
	it('changes one constant on the same GUID and preserves layout, other chips, unknown fields and geometry', () => {
		const ws = workspace(),
			path = changeValue(ws, 8),
			compiled = ws.compile(),
			after = workspace(compiled.bytes)
		expect(
			after.nodes.get(ids.source)!.data.node_groups[0].inputs[0].default_signal_value
				.DEPRECATED_backing_float
		).toBe(8)
		expect(after.nodes.get(ids.source)!.data.transform_data).toEqual(
			ws.nodes.get(ids.source)!.data.transform_data
		)
		expect(after.nodes.get(ids.other)!.bytes).toEqual(ws.nodes.get(ids.other)!.bytes)
		expect(
			fields(compiled.bytes)
				.filter((field) => field.number !== 28)
				.map((field) => field.raw)
		).toEqual(
			fields(ws.document.bytes)
				.filter((field) => field.number !== 28)
				.map((field) => field.raw)
		)
		expect(compiled.diff).toMatchObject({ files: [path], chipsChanged: 1, chipsCreated: 0 })
	})
	it('recursively preserves unknown fields when a known nested value changes', () => {
		const original = join([
			nodeType.encode(nodeType.fromObject(node(ids.source, true))).finish(),
			Uint8Array.from([0xc0, 0x3e, 7]),
		])
		const next = decode(nodeType, original)
		next.node_name = 'Changed'
		expect(fields(update(nodeType, original, next)).find((f) => f.number === 1000)!.raw).toEqual(
			Uint8Array.from([0xc0, 0x3e, 7])
		)
	})
	it('rejects malformed protobuf and malformed IR', () => {
		expect(() => new RoomDocument(Uint8Array.from([0xe2, 1, 100]))).toThrow()
		expect(() => parse('graph bad', 'x.cv2')).toThrow('x.cv2:1')
		expect(() => fields(Uint8Array.from([8, 128]))).toThrow('Truncated')
	})
	it('rejects stale/nonunique patches without changing the workspace', () => {
		const ws = workspace(),
			path = sourcePath(ws),
			before = ws.files.get(path)!.text
		expect(() => ws.patch(path, 1, [{ old: 'Delay', new: 'Test' }])).toThrow('stale')
		expect(() => ws.patch(path, 0, [{ old: 'field', new: 'field' }])).toThrow('exactly once')
		expect(ws.files.get(path)!.text).toBe(before)
	})
	it.each([
		['invented chip type', ids.sourceType, '99'.repeat(16), 'type'],
		[
			'wrong scalar type',
			'"DEPRECATED_backing_float":5',
			'"DEPRECATED_backing_float":"eight"',
			'finite float',
		],
		[
			'nonexistent field',
			'field node_name = "Delay"',
			'field imaginary_port = "Delay"',
			'nonexistent',
		],
		['fabricated stable ID', ids.source, '98'.repeat(16), 'fabricated'],
		[
			'payload belonging to an unverified chip type',
			'field node_name = "Delay"',
			'field node_name = "Delay"\n    field comment_node_data = {"text":"Invented payload"}',
			'configuration variant',
		],
	])('rejects %s with actionable source locations', (_, old, replacement, message) => {
		const ws = workspace(),
			path = sourcePath(ws)
		// The chip ID also appears on its wire. Use the unique @id header for this case.
		const edits =
			old === ids.source
				? [{ old: `@id("${old}")`, new: `@id("${replacement}")` }]
				: [{ old, new: replacement }]
		ws.patch(path, 0, edits)
		expect(() => ws.compile()).toThrow(message)
	})
	it('creates a known registry chip, assigns a unique ID, and places it nearby', () => {
		const ws = workspace(),
			path = sourcePath(ws)
		ws.patch(path, 0, [
			{
				old: '\n}\n',
				new: `\n  @id("new:extra") chip "${getCv2DefinitionRegistry().getChip('Get Local Player')!.typeId}" {\n    field node_name = "New source"\n  }\n}\n`,
			},
		])
		const compiled = ws.compile(),
			after = workspace(compiled.bytes),
			key = ws.newIds.get('new:extra')!
		expect(key).toMatch(/^[a-f0-9]{32}$/)
		expect(after.nodes.get(key)!.data.transform_data.local_position.x).toBeGreaterThan(3)
		expect(after.nodes.get(ids.source)!.data.transform_data).toEqual(
			ws.nodes.get(ids.source)!.data.transform_data
		)
		expect(compiled.diff.chipsCreated).toBe(1)
		expect(ws.compile().bytes).toEqual(compiled.bytes)
	})
	it('allows field edits but rejects topology changes when entity topology is present', () => {
		const ws = workspace(save({ entities: true })),
			path = changeValue(ws, 8)
		expect(() => ws.compile()).not.toThrow()
		const file = ws.files.get(path)!,
			line = file.text.split('\n').find((line) => line.startsWith('  wire'))!
		ws.patch(path, file.revision, [{ old: line + '\n', new: '' }])
		expect(() => ws.compile()).toThrow('entity topology')
	})
	it('rejects connections with nonexistent ports', () => {
		const ws = workspace(),
			path = sourcePath(ws),
			edge = ws.files.get(path)!.script.edges[0]!
		ws.patch(path, 0, [{ old: stable(edge.data), new: stable({ ...edge.data, src_port_id: 123 }) }])
		expect(() => ws.compile()).toThrow('does not exist')
	})
	it('rejects new connections with incompatible types', () => {
		const data = decode(roomType, save()),
			other = node(ids.other, false)
		other.out_node_data!.node_desc.inputs[0]!.type.kind = 'Int32'
		data.circuit_v2_data.root.node_datas[2] = other
		const ws = workspace(roomType.encode(roomType.fromObject(data)).finish()),
			path = sourcePath(ws)
		ws.patch(path, 0, [
			{
				old: '\n}\n',
				new: `\n  wire "new:invalid" = ${stable({ src_node_id: guid(ids.source), dst_node_id: guid(ids.other) })}\n}\n`,
			},
		])
		expect(() => ws.compile()).toThrow('incompatible')
	})
	it('rejects new data fan-in even when the new wire appears before the existing one', () => {
		const ws = workspace(),
			path = sourcePath(ws),
			file = ws.files.get(path)!
		const header = file.text.split('\n')[0]!
		ws.patch(path, 0, [
			{
				old: header,
				new: `${header}\n  wire "new:fanin" = ${stable({ src_node_id: guid(ids.other), dst_node_id: guid(ids.target) })}`,
			},
		])
		expect(() => ws.compile()).toThrow('already has a data connection')
	})
	it('requires fresh graph validation, room validation, and diff review before finish', () => {
		const ws = workspace(),
			path = changeValue(ws, 8)
		expect(() => ws.finish()).toThrow('validate')
		ws.validateGraph(path)
		ws.validateRoom()
		ws.inspectDiff()
		expect(ws.finish().diff.chipsChanged).toBe(1)
		ws.patch(path, 1, [
			{ old: '"DEPRECATED_backing_float":8', new: '"DEPRECATED_backing_float":9' },
		])
		expect(() => ws.finish()).toThrow('validate')
	})
	it('rebases onto unrelated component edits and aborts changes to the same component', () => {
		const ws = workspace()
		changeValue(ws, 8)
		const latest = workspace()
		changeValue(latest, 9, ids.other)
		const rebased = workspace(ws.rebase(workspace(latest.compile().bytes), ws.compile()))
		expect(
			rebased.nodes.get(ids.source)!.data.node_groups[0].inputs[0].default_signal_value
				.DEPRECATED_backing_float
		).toBe(8)
		expect(
			rebased.nodes.get(ids.other)!.data.node_groups[0].inputs[0].default_signal_value
				.DEPRECATED_backing_float
		).toBe(9)
		const conflicting = workspace()
		changeValue(conflicting, 10)
		expect(() => ws.rebase(workspace(conflicting.compile().bytes), ws.compile())).toThrow(
			'conflict'
		)
	})
	it.skipIf(!process.env.CV2_NATIVE_ROOM)('preserves a native exported room byte-for-byte', () => {
		const bytes = new Uint8Array(readFileSync(process.env.CV2_NATIVE_ROOM!)),
			ws = workspace(bytes)
		expect(ws.nodes.size).toBeGreaterThan(100)
		expect(equalBytes(ws.compile().bytes, bytes)).toBe(true)
	})
	it.skipIf(!process.env.CV2_NATIVE_ROOM)(
		'edits a native constant while retaining every other chip and entity byte',
		() => {
			const bytes = new Uint8Array(readFileSync(process.env.CV2_NATIVE_ROOM!)),
				ws = workspace(bytes)
			const [path, file] = [...ws.files].find(([, file]) =>
				file.script.nodes.some((node) =>
					node.data.node_groups?.some((group: any) =>
						group.inputs?.some(
							(input: any) =>
								typeof input.default_signal_value?.DEPRECATED_int32_backing_bytes === 'number'
						)
					)
				)
			)!
			const node = file.script.nodes.find((node) =>
				node.data.node_groups?.some((group: any) =>
					group.inputs?.some(
						(input: any) =>
							typeof input.default_signal_value?.DEPRECATED_int32_backing_bytes === 'number'
					)
				)
			)!
			const groups = structuredClone(node.data.node_groups)
			const signal = groups
				.flatMap((group: any) => group.inputs ?? [])
				.find(
					(input: any) =>
						typeof input.default_signal_value?.DEPRECATED_int32_backing_bytes === 'number'
				).default_signal_value
			signal.DEPRECATED_int32_backing_bytes +=
				signal.DEPRECATED_int32_backing_bytes === 2147483647 ? -1 : 1
			const start = file.text.indexOf(`  @id("${node.id}")`)
			const block = file.text.slice(start, file.text.indexOf('\n  }', start) + 4)
			ws.patch(path, 0, [
				{ old: block, new: block.replace(stable(node.data.node_groups), stable(groups)) },
			])
			const compiled = ws.compile(),
				after = workspace(compiled.bytes)
			expect(compiled.diff.chipsChanged).toBe(1)
			expect(after.nodes.get(node.id)!.data.node_groups).toEqual(groups)
			for (const [key, original] of ws.nodes)
				if (key !== node.id) expect(after.nodes.get(key)!.bytes).toEqual(original.bytes)
			const metadata = (raw: Uint8Array) =>
				fields(raw)
					.filter((field) => field.number === 28)
					.flatMap((field) =>
						fields(field.data)
							.filter((child) => child.number !== 2)
							.map((child) => child.raw)
					)
			expect(metadata(compiled.bytes)).toEqual(metadata(bytes))
		}
	)
})

async function setup() {
	const db = new SQLiteD1(':memory:')
	for (const ddl of [...ROOM_SCHEMA_DDL, ...SUBROOM_SCHEMA_DDL]) await db.exec(ddl)
	await db.exec(
		readFileSync(new URL('../../discovery/migrations/0004_cv2_agent.sql', import.meta.url), 'utf8')
	)
	await db
		.prepare('INSERT INTO room(data) VALUES (?1)')
		.bind(
			JSON.stringify({
				RoomId: 9001,
				Name: 'AgentTest',
				CreatorAccountId: 123,
				IsDorm: false,
				Description: 'Preserve me',
			})
		)
		.run()
	await db
		.prepare('INSERT INTO subroom(room_id,data) VALUES (9001,?1)')
		.bind(JSON.stringify({ Name: 'Main', CreatorAccountId: 123 }))
		.run()
	const base = {
		DataBlob: 'original.room',
		PersistenceVersion: 179,
		OMVersion: 4,
		UgcSubVersion: 3,
		UnitySubAssets: [{ Id: 'preserved' }],
		ModerationState: 0,
		Description: 'Original',
	}
	await db
		.prepare('INSERT INTO subroom_save(sub_room_id,data) VALUES (1,?1)')
		.bind(JSON.stringify(base))
		.run()
	await db.prepare('UPDATE subroom SET current_save_id=1 WHERE sub_room_id=1').run()
	const blobs = new Map<string, Uint8Array>([['room/original.room', save()]])
	const put = vi.fn(async (key: string, bytes: Uint8Array) => {
		blobs.set(key, bytes)
		return {}
	})
	const remove = vi.fn(async (key: string) => {
		blobs.delete(key)
	})
	const env = {
		DB: db,
		CDN_ASSETS: {
			get: async (key: string) => {
				const bytes = blobs.get(key)
				return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null
			},
			put,
			delete: remove,
		},
		OPENAIKEY: { get: async () => 'sk-test-secret' },
		RRTOKEN: { get: async () => 'token-test-secret' },
		NAME: 'discovery',
		ENVIRONMENT: 'VITEST',
		SENTRY_RELEASE: 'test',
	} as unknown as Env
	return { db, env, blobs, put, remove }
}
function request(command: string, env: Env, ctx = new NodeExecutionContext()) {
	return app.fetch(
		new Request(`https://discovery.example.com/sections/pagesource/${encodeURIComponent(command)}`),
		env,
		ctx as never
	)
}
function response(name: string, args: unknown) {
	return Response.json({
		status: 'completed',
		output: [
			{
				type: 'function_call',
				call_id: crypto.randomUUID(),
				name,
				arguments: JSON.stringify(args),
			},
		],
		usage: { total_tokens: 100 },
	})
}

describe('CV2AGENT integration and save commits', () => {
	it('commits canonical chip creation on an empty graph without any room template', async () => {
		const { db, env, blobs } = await setup(),
			ctx = new NodeExecutionContext()
		const bytes = new Uint8Array(
			roomType
				.encode(
					roomType.fromObject({
						activity_id: 'Preserve geometry',
						circuit_v2_data: {
							version: 'V80UnbindMisconfiguredEventSenders',
							root: { graph_id: guid(ids.graph) },
						},
					})
				)
				.finish()
		)
		blobs.set('room/original.room', bytes)
		const ws = workspace(bytes),
			path = [...ws.files.keys()][0]!
		const steps = [
			[
				'create_chip',
				{
					graph: path,
					revision: 0,
					type: 'Player Get Is Grounded',
					label: 'grounded',
					configuration: null,
					name: null,
					bindings: [],
					variable: null,
				},
			],
			['validate_graph', { graph: path }],
			['validate_room', {}],
			['get_diff', {}],
			['finish', {}],
		] as const
		let calls = 0
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			const [name, args] = steps[calls++]!
			return response(name, args)
		})
		vi.spyOn(console, 'info').mockImplementation(() => {})
		try {
			const res = await request(
				'CV2AGENT[Room:"AgentTest",Prompt:"Create a grounded chip"]8254TOKEN"token-test-secret"',
				env,
				ctx
			)
			const run = ((await res.json()) as any[])[0].id
			await ctx.drain()
			expect(
				await db
					.prepare('SELECT state,final_save_id FROM cv2_agent_run WHERE run_id=?1')
					.bind(run)
					.first()
			).toEqual({ state: 'done', final_save_id: 2 })
			expect(calls).toBe(5)
			const afterSave = JSON.parse(
				(await db
					.prepare('SELECT data FROM subroom_save WHERE sub_room_data_save_id=2')
					.first<any>())!.data
			)
			const after = workspace(blobs.get(`room/${afterSave.DataBlob}`)!)
			expect(after.nodes.size).toBe(1)
			expect([...after.nodes.values()][0].data.node_type).toEqual(
				guid(after.registry.getChip('Player Get Is Grounded')!.typeId)
			)
			expect(blobs.get('room/original.room')).toEqual(bytes)
		} finally {
			db.close()
		}
	})
	it('starts the agent with global definitions even when a valid room has no chips', async () => {
		const { db, env, blobs, put } = await setup(),
			ctx = new NodeExecutionContext()
		blobs.set(
			'room/original.room',
			new Uint8Array(roomType.encode(roomType.fromObject({ activity_id: 'Empty room' })).finish())
		)
		const calls: any[] = []
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
			calls.push(JSON.parse(init!.body as string))
			return calls.length === 1
				? response('get_chip_definition', { type: 'Player Get Is Grounded' })
				: response('abort', { reason: 'No verified serialized creation template' })
		})
		vi.spyOn(console, 'info').mockImplementation(() => {})
		try {
			await request(
				'CV2AGENT[Room:"AgentTest",Prompt:"double jump"]8254TOKEN"token-test-secret"',
				env,
				ctx
			)
			await ctx.drain()
			expect(await db.prepare('SELECT state,error FROM cv2_agent_run').first()).toMatchObject({
				state: 'failed',
				error: expect.stringContaining('No verified serialized creation template'),
			})
			expect(calls).toHaveLength(2)
			const result = JSON.parse(calls[1].input.at(-1).output)
			expect(result.globalDefinition.name).toBe('Player Get Is Grounded')
			expect(result.totalInstances).toBe(0)
			expect(put).not.toHaveBeenCalled()
		} finally {
			db.close()
		}
	})
	it('authenticates before room access or OpenAI and rejects missing prompts', async () => {
		const { db, env } = await setup()
		try {
			const outbound = vi.spyOn(globalThis, 'fetch')
			expect(
				(await request('CV2AGENT[Room:"AgentTest",Prompt:"test"]8254TOKEN"wrong"', env)).status
			).toBe(401)
			const invalid = await request('CV2AGENT[Room:"AgentTest"]8254TOKEN"token-test-secret"', env)
			expect(((await invalid.json()) as any[])[0].id).toContain('Prompt')
			expect(outbound).not.toHaveBeenCalled()
		} finally {
			db.close()
		}
	})
	it('runs tools end to end, appends a commented save, retains history/assets and serves status', async () => {
		const { db, env, blobs } = await setup(),
			ctx = new NodeExecutionContext(),
			ws = workspace(),
			path = sourcePath(ws)
		const steps = [
			['read_graph', { graph: path, start: 1, count: 100 }],
			[
				'apply_patch',
				{
					graph: path,
					revision: 0,
					edits: [{ old: '"DEPRECATED_backing_float":5', new: '"DEPRECATED_backing_float":8' }],
				},
			],
			['validate_graph', { graph: path }],
			['validate_room', {}],
			['get_diff', {}],
			['finish', {}],
		] as const
		const calls: any[] = []
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
			calls.push(JSON.parse(init!.body as string))
			const step = steps[calls.length - 1]!
			return response(step[0], step[1])
		})
		const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
		try {
			const res = await request(
				'CV2AGENT[Room:"AgentTest",Prompt:"Increase duration to 8",RequestId:"run-once"]8254TOKEN"token-test-secret"',
				env,
				ctx
			)
			const run = ((await res.json()) as any[])[0].id
			expect(run).toMatch(/^cv2agent_/)
			await ctx.drain()
			const status = await request(`CV2AGENTSTATUS[Run:"${run}"]8254TOKEN"token-test-secret"`, env)
			expect(((await status.json()) as any[])[0].id).toBe('done:Save:2')
			const history = await db
				.prepare('SELECT data FROM subroom_save ORDER BY sub_room_data_save_id')
				.all<{ data: string }>()
			expect(history.results).toHaveLength(2)
			const after = JSON.parse(history.results[1]!.data)
			expect(after).toMatchObject({
				Description: 'AI Run "Increase duration to 8" Complete',
				OMVersion: 4,
				UgcSubVersion: 3,
				UnitySubAssets: [{ Id: 'preserved' }],
			})
			expect(blobs.get('room/original.room')).toEqual(save())
			expect(
				workspace(blobs.get(`room/${after.DataBlob}`)!).nodes.get(ids.source)!.data.node_groups[0]
					.inputs[0].default_signal_value.DEPRECATED_backing_float
			).toBe(8)
			expect(
				await db.prepare('SELECT current_save_id,staged_save_id FROM subroom').first()
			).toEqual({ current_save_id: 1, staged_save_id: 2 })
			const repeat = await request(
				'CV2AGENT[Room:"AgentTest",Prompt:"Increase duration to 8",RequestId:"run-once"]8254TOKEN"token-test-secret"',
				env
			)
			expect(((await repeat.json()) as any[])[0].id).toBe(run)
			expect(fetch).toHaveBeenCalledTimes(6)
			expect(calls.every((call) => call.model === 'gpt-6.1-sol')).toBe(true)
			expect(calls[0].input).toEqual([{ role: 'user', content: 'Increase duration to 8' }])
			expect(JSON.stringify(logs.mock.calls)).not.toContain('sk-test-secret')
			expect(JSON.stringify(logs.mock.calls)).not.toContain('token-test-secret')
		} finally {
			db.close()
		}
	})
	it('creates no partial save on an API failure and does not log upstream secrets', async () => {
		const { db, env, put } = await setup(),
			ctx = new NodeExecutionContext()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('sk-test-secret', { status: 500 }))
		const log = vi.spyOn(console, 'info').mockImplementation(() => {})
		try {
			await request(
				'CV2AGENT[Room:"AgentTest",Prompt:"test"]8254TOKEN"token-test-secret"',
				env,
				ctx
			)
			await ctx.drain()
			expect(await db.prepare('SELECT state,error FROM cv2_agent_run').first()).toMatchObject({
				state: 'failed',
				error: 'OpenAI API failed with HTTP 500',
			})
			expect((await db.prepare('SELECT COUNT(*) n FROM subroom_save').first<any>())!.n).toBe(1)
			expect(put).not.toHaveBeenCalled()
			expect(JSON.stringify(log.mock.calls)).not.toContain('sk-test-secret')
		} finally {
			db.close()
		}
	})
	it('limits compiler repair attempts and provides errors back to the model', async () => {
		const ws = workspace(),
			path = sourcePath(ws)
		ws.patch(path, 0, [{ old: 'field node_name = "Delay"', new: 'field invalid_field = "Delay"' }])
		const fetch = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => response('validate_room', {}))
		await expect(
			runAgent(
				ws,
				'test',
				'key',
				() => {},
				async () => {},
				Date.now() + 100000
			)
		).rejects.toThrow('5 repair attempts')
		expect(fetch).toHaveBeenCalledTimes(5)
		expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).input.at(-1).output).toContain(
			'nonexistent'
		)
	})
	it('atomically rejects stale history and changed publication pointers without adding a row', async () => {
		const { db, env } = await setup()
		try {
			const base = await snapshot(env, 9001, 1)
			await db.prepare('UPDATE subroom SET staged_save_id=1').run()
			expect(
				await appendSubRoomSaveIfLatest(env.DB, 9001, 1, 123, base.save, base.expected, {
					dataBlob: 'new.room',
					dataBlobHash: 'hash',
					description: 'test',
					publish: false,
				})
			).toBeNull()
			expect((await db.prepare('SELECT COUNT(*) n FROM subroom_save').first<any>())!.n).toBe(1)
		} finally {
			db.close()
		}
	})
	it('rebases a newer unrelated save and aborts a concurrent same-component edit', async () => {
		const { db, env, blobs, put } = await setup()
		try {
			const base = await snapshot(env, 9001, 1),
				ws = workspace()
			changeValue(ws, 8)
			const newer = workspace()
			changeValue(newer, 9, ids.other)
			blobs.set('room/user.room', newer.compile().bytes)
			await db
				.prepare('INSERT INTO subroom_save(sub_room_id,data) VALUES (1,?1)')
				.bind(JSON.stringify({ ...base.save, DataBlob: 'user.room' }))
				.run()
			const saved = await commitSave(env, 9001, 1, 'test', 'test', base, ws, ws.compile(), () => {})
			expect(saved).toBe(3)
			const conflicting = workspace()
			changeValue(conflicting, 10)
			blobs.set('room/conflict.room', conflicting.compile().bytes)
			await db
				.prepare('INSERT INTO subroom_save(sub_room_id,data) VALUES (1,?1)')
				.bind(JSON.stringify({ ...base.save, DataBlob: 'conflict.room' }))
				.run()
			await expect(
				commitSave(env, 9001, 1, 'test2', 'test', base, ws, ws.compile(), () => {})
			).rejects.toThrow('unsafe')
			expect(put).toHaveBeenCalledTimes(1)
		} finally {
			db.close()
		}
	})
	it('expires interrupted runs and sanitizes save comments', async () => {
		const { db, env } = await setup()
		try {
			await db
				.prepare(
					"INSERT INTO cv2_agent_run(run_id,request_id,room_id,sub_room_id,prompt,state,created_at,updated_at,deadline_at) VALUES ('test','test',9001,1,'test','running','2000','2000','2000')"
				)
				.run()
			await resumeCV2Agents(env)
			expect(await db.prepare('SELECT state FROM cv2_agent_run').first('state')).toBe('failed')
			expect(saveComment('x\n"y"\u0000')).toBe('AI Run "x y" Complete')
			expect(saveComment('x'.repeat(500)).length).toBeLessThan(230)
		} finally {
			db.close()
		}
	})
})
