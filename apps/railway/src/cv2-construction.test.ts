import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent } from '../../discovery/src/cv2-agent/agent'
import catalog from '../../discovery/src/cv2-agent/construction-catalog.json'
import { parse, serialize } from '../../discovery/src/cv2-agent/language'
import {
	decode,
	fields,
	guid,
	id,
	join,
	nodeType,
	roomType,
} from '../../discovery/src/cv2-agent/protobuf'
import { getCv2DefinitionRegistry } from '../../discovery/src/cv2-agent/registry'
import { RoomDocument } from '../../discovery/src/cv2-agent/room'
import { RoomWorkspace } from '../../discovery/src/cv2-agent/workspace'

import type { ConstructionRecipe } from '../../discovery/src/cv2-agent/construction'
import type { RecordData } from '../../discovery/src/cv2-agent/protobuf'

const registry = getCv2DefinitionRegistry()
const graphId = '11'.repeat(16)
function room(nodes: RecordData[] = [], entities = false) {
	return join([
		roomType
			.encode(
				roomType.fromObject({
					activity_id: 'geometry must survive',
					circuit_v2_data: {
						version: 'V80UnbindMisconfiguredEventSenders',
						root: { graph_id: guid(graphId), node_datas: nodes },
						...(entities ? { entities: {} } : {}),
					},
				})
			)
			.finish(),
		Uint8Array.from([0xc0, 0x3e, 7]),
	])
}
const workspace = (nodes: RecordData[] = []) => new RoomWorkspace(new RoomDocument(room(nodes)))
const path = (ws: RoomWorkspace) => [...ws.files.keys()][0]!
function create(
	ws: RoomWorkspace,
	type: string,
	label: string,
	bindings: Record<string, string> = {},
	variable?: { name: string; memory_type?: string }
) {
	const graph = path(ws)
	return ws.createChip(
		graph,
		ws.files.get(graph)!.revision,
		type,
		label,
		undefined,
		bindings,
		undefined,
		variable
	)
}
function connect(
	ws: RoomWorkspace,
	source: string,
	sourcePort: number,
	target: string,
	targetPort: number,
	key = 'link'
) {
	const graph = path(ws),
		file = ws.files.get(graph)!
	const edge = {
		src_node_id: { value: source },
		dst_node_id: { value: target },
		src_port_id: sourcePort,
		dst_port_id: targetPort,
	}
	const script = {
		...file.script,
		edges: [...file.script.edges, { key: `new:${key}`, data: edge, line: 0 }],
	}
	ws.patch(graph, file.revision, [{ old: file.text, new: serialize(script) }])
}
function bindings(recipe: ConstructionRecipe) {
	return Object.fromEntries(
		recipe.groups.flatMap((group) =>
			Object.entries(group.typeParameters)
				.filter(([name]) =>
					[...group.inputs, ...group.outputs].some((port: RecordData) =>
						port.ReadonlyType.split(/[^A-Za-z0-9_]+/).includes(name)
					)
				)
				.map(([name, constraint]) => [
					name,
					constraint === 'any'
						? 'int'
						: String(constraint)
								.replace(/^\(|\)$/g, '')
								.split('|')[0]
								.trim(),
				])
		)
	)
}
afterEach(() => vi.restoreAllMocks())

describe('registry-backed canonical CV2 chip construction', () => {
	it('creates every supported recipe as fresh protobuf objects without a target-room template or scoped source IDs', () => {
		expect(registry.info.constructibleChipCount).toBe(232)
		for (const value of catalog.recipes) {
			const recipe = value as ConstructionRecipe
			const options = {
				recipe: recipe.id,
				bindings: bindings(recipe),
				...(recipe.variable
					? { variable: { name: 'Fresh Variable', memory_type: 'Instance' } }
					: {}),
			}
			const a = registry.construction.construct(recipe.typeId, '22'.repeat(16), options)
			const b = registry.construction.construct(recipe.typeId, '33'.repeat(16), options)
			expect(id(a.data.node_id)).toBe('22'.repeat(16))
			expect(id(b.data.node_id)).toBe('33'.repeat(16))
			expect(id(a.data.node_type)).toBe(recipe.typeId)
			expect(a.data.node_groups).not.toBe(b.data.node_groups)
			expect(a.data.node_groups).toEqual(recipe.nodeGroups)
			const encoded = nodeType.encode(nodeType.fromObject(a.data)).finish()
			expect(id(decode(nodeType, encoded).node_id)).toBe('22'.repeat(16))
			expect(
				Object.keys(a.data).some((name) => /event|graph_node|board_bus|invention/.test(name))
			).toBe(false)
			expect(Object.isFrozen(registry.construction.get(recipe.typeId, recipe.id).nodeGroups)).toBe(
				true
			)
		}
	})
	it('materializes an empty graph and constructs/wires grounded-state logic, retaining unrelated bytes', () => {
		const ws = workspace(),
			original = ws.document.bytes
		expect(ws.nodes.size).toBe(0)
		expect(ws.files.size).toBe(1)
		create(ws, 'Get Local Player', 'player')
		create(ws, 'Player Get Is Grounded', 'grounded')
		create(ws, 'If', 'branch')
		connect(ws, 'new:player', 0, 'new:grounded', 0, 'player_to_grounded')
		connect(ws, 'new:grounded', 0, 'new:branch', 1, 'grounded_to_branch')
		const compiled = ws.compile(),
			after = new RoomWorkspace(new RoomDocument(compiled.bytes))
		expect(compiled.diff).toMatchObject({ chipsCreated: 3, connectionsAdded: 2 })
		expect(after.nodes.size).toBe(3)
		expect([...after.document.graphs.values()][0].data.edges).toHaveLength(2)
		expect(
			fields(compiled.bytes)
				.filter((field) => field.number !== 28)
				.map((field) => field.raw)
		).toEqual(
			fields(original)
				.filter((field) => field.number !== 28)
				.map((field) => field.raw)
		)
		expect(after.compile().bytes).toEqual(compiled.bytes)
		expect(ws.compile().bytes).toEqual(compiled.bytes)
		ws.validateGraph(path(ws))
		ws.validateRoom()
		ws.inspectDiff()
		expect(ws.finish().bytes).toEqual(compiled.bytes)
	})
	it('constructs new types in a room containing only a string variable and keeps that original chip intact', () => {
		const seed = registry.construction.construct(
			registry.getChip('string Variable')!.typeId,
			'aa'.repeat(16),
			{ variable: { name: 'Original', memory_type: 'Instance' } }
		).data
		seed.node_name = 'Existing string chip'
		const ws = workspace([seed]),
			before = ws.nodes.get('aa'.repeat(16))!.bytes
		create(ws, 'Get Local Player', 'player')
		create(ws, 'Player Get Is Grounded', 'grounded')
		connect(ws, 'new:player', 0, 'new:grounded', 0)
		const after = new RoomWorkspace(new RoomDocument(ws.compile().bytes))
		expect(after.nodes.size).toBe(3)
		expect(after.nodes.get('aa'.repeat(16))!.bytes).toEqual(before)
	})
	it('declares fresh variables and rejects conflicting graph-scoped types or memory modes', () => {
		const ws = workspace()
		create(ws, 'bool Variable', 'a', {}, { name: 'CanDoubleJump', memory_type: 'Instance' })
		create(ws, 'bool Variable', 'b', {}, { name: 'CanDoubleJump', memory_type: 'Instance' })
		expect(ws.compile().diff.chipsCreated).toBe(2)
		create(ws, 'float Variable', 'c', {}, { name: 'CanDoubleJump', memory_type: 'Instance' })
		expect(() => ws.compile()).toThrow('conflicts')
		expect(() =>
			registry.construction.construct(registry.getChip('bool Variable')!.typeId, '22'.repeat(16))
		).toThrow('explicit nonempty name')
	})
	it('validates generic constraints and requires concrete wire evidence for runtime inference', () => {
		const ws = workspace()
		create(ws, 'Add', 'sum', { T: 'float' })
		expect(() => ws.compile()).toThrow('no concrete connection')
		create(ws, 'float Variable', 'value', {}, { name: 'JumpSpeed' })
		connect(ws, 'new:value', 1, 'new:sum', 0)
		expect(ws.compile().diff.connectionsAdded).toBe(1)
		const recipes = registry.construction.list(registry.getChip('Add')!.typeId)
		expect(recipes.some((recipe) => recipe.nodeGroups[0].inputs.length === 3)).toBe(true)
		expect(() =>
			registry.construction.construct(recipes[0].typeId, '22'.repeat(16), {
				bindings: { T: 'bool' },
			})
		).toThrow('does not satisfy')
		expect(() =>
			registry.construction.construct(recipes[0].typeId, '22'.repeat(16), {
				bindings: { T: 'InventedType' },
			})
		).toThrow('known concrete')
		const graph = path(ws),
			file = ws.files.get(graph)!
		ws.patch(graph, file.revision, [
			{ old: 'bindings = {"T":"float"}', new: 'bindings = {"T":"int"}' },
		])
		expect(() => ws.compile()).toThrow('incompatible')
	})
	it('propagates type evidence through generic chains but rejects cycles with no concrete source', () => {
		const ws = workspace()
		create(ws, 'Add', 'a', { T: 'float' })
		create(ws, 'Add', 'b', { T: 'float' })
		connect(ws, 'new:a', 0, 'new:b', 0, 'ab')
		connect(ws, 'new:b', 0, 'new:a', 0, 'ba')
		expect(() => ws.compile()).toThrow('no concrete connection')
		create(ws, 'float Variable', 'float', {}, { name: 'Seed' })
		connect(ws, 'new:float', 1, 'new:a', 1, 'seed')
		expect(ws.compile().diff.connectionsAdded).toBe(3)
	})
	it('rejects nonexistent chips, unverified layouts, ports, incompatible wires and scoped bindings', () => {
		const ws = workspace()
		expect(() => create(ws, 'InventedChip', 'fake')).toThrow('Unknown CV2')
		expect(() => create(ws, 'Event Receiver', 'event')).toThrow('no verified canonical')
		expect(() => create(ws, 'Player Right Hand Position', 'hand')).toThrow('no verified canonical')
		create(ws, 'Get Local Player', 'player')
		create(ws, 'Player Get Is Grounded', 'grounded')
		connect(ws, 'new:player', 5, 'new:grounded', 0)
		expect(() => ws.compile()).toThrow('port 0.5 does not exist')
		const other = workspace()
		create(other, 'If', 'if')
		create(other, 'Player Get Is Grounded', 'grounded')
		connect(other, 'new:grounded', 1, 'new:if', 1)
		expect(() => other.compile()).toThrow('incompatible')
	})
	it('rejects profile tampering, unsafe payload substitutions and entity topology changes', () => {
		const ws = workspace()
		create(ws, 'Player Get Is Grounded', 'grounded')
		const graph = path(ws),
			file = ws.files.get(graph)!
		const script = parse(file.text, graph)
		script.nodes[0].data.event_receiver_node_data = {}
		ws.patch(graph, file.revision, [{ old: file.text, new: serialize(script) }])
		expect(() => ws.compile()).toThrow('configuration variant cannot be added')
		const withEntities = new RoomWorkspace(new RoomDocument(room([], true)))
		expect(() => create(withEntities, 'Player Get Is Grounded', 'grounded')).toThrow(
			'entity topology adapter'
		)
		const known = registry.getChip('Player Get Is Grounded')!
		expect(() =>
			registry.construction.get(known.typeId, `canonical:${known.typeId}:ffffffffffffffff`)
		).toThrow('Unknown construction recipe')
	})
	it('creates, wires, validates, inspects and finishes an empty-room agent run through canonical tools', async () => {
		const ws = workspace(),
			graph = path(ws),
			calls: RecordData[] = []
		const common = { graph, recipe: null, name: null, bindings: [], variable: null }
		const steps = [
			['get_chip_construction', { type: 'Get Local Player', recipe: null }],
			['create_chip', { ...common, revision: 0, type: 'Get Local Player', label: 'player' }],
			[
				'create_chip',
				{ ...common, revision: 1, type: 'Player Get Is Grounded', label: 'grounded' },
			],
			['read_graph', { graph, start: 1, count: 200 }],
			[
				'apply_patch',
				{
					graph,
					revision: 2,
					edits: [
						{
							old: '\n}\n',
							new: '\n  wire "new:link" = {"src_node_id":{"value":"new:player"},"dst_node_id":{"value":"new:grounded"}}\n}\n',
						},
					],
				},
			],
			['validate_graph', { graph }],
			['validate_room', {}],
			['get_diff', {}],
			['finish', {}],
		] as const
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
			calls.push(JSON.parse(init!.body as string))
			const [name, args] = steps[calls.length - 1]!
			return Response.json({
				status: 'completed',
				output: [
					{
						type: 'function_call',
						call_id: `call_${calls.length}`,
						name,
						arguments: JSON.stringify(args),
					},
				],
			})
		})
		const result = await runAgent(
			ws,
			'Build grounded check',
			'key',
			() => {},
			async () => {},
			Date.now() + 100000
		)
		expect(result.diff).toMatchObject({ chipsCreated: 2, connectionsAdded: 1 })
		expect(calls).toHaveLength(steps.length)
		expect(calls.slice(1).every((call) => !JSON.parse(call.input.at(-1).output).error)).toBe(true)
	})
})
