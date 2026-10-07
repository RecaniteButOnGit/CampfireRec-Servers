import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent } from '../../discovery/src/cv2-agent/agent'
import { guid, roomType } from '../../discovery/src/cv2-agent/protobuf'
import published from '../../discovery/src/cv2-agent/published-catalog.json'
import references from '../../discovery/src/cv2-agent/reference-catalog.json'
import { getCv2DefinitionRegistry } from '../../discovery/src/cv2-agent/registry'
import { RoomDocument } from '../../discovery/src/cv2-agent/room'
import { RoomWorkspace } from '../../discovery/src/cv2-agent/workspace'

const registry = getCv2DefinitionRegistry()
const groundedGuid = '4db35e9d-3a1d-4823-a011-7f94e028a3e7'
const groundedType = '9d5eb34d1d3a2348a0117f94e028a3e7'
const empty = () =>
	new RoomWorkspace(
		new RoomDocument(
			roomType
				.encode(
					roomType.fromObject({
						activity_id: 'Empty room',
						circuit_v2_data: { root: { graph_id: guid('11'.repeat(16)) } },
					})
				)
				.finish()
		)
	)
afterEach(() => vi.restoreAllMocks())

describe('authoritative global CV2 registry', () => {
	it('shares one immutable registry between empty workspaces without fetching metadata', () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
		const a = empty(),
			b = empty()
		expect(a.nodes.size).toBe(0)
		expect(a.registry).toBe(b.registry)
		expect(a.registry).toBe(registry)
		expect(getCv2DefinitionRegistry()).toBe(registry)
		expect(Object.isFrozen(registry.info.provenance.officialCatalog)).toBe(true)
		expect(Object.isFrozen(registry.getChip('Player Get Is Grounded')!.inputs)).toBe(true)
		expect(fetch).not.toHaveBeenCalled()
	})
	it('exposes every pinned official chip and distinguishes the public palette from hidden/dev entries', () => {
		expect(registry.info.publishedChipCount).toBe(1328)
		expect(registry.info.paletteChipCount).toBe(1147)
		for (const chip of published.chips) {
			const definition = registry.getChip(chip.runtimeGuid)!
			expect(definition.typeId).toBe(chip.typeId)
			expect(definition.metadata).toEqual(chip.metadata)
			expect(definition.availability.inPublishedPalette).toBe(chip.inPalette)
		}
	})
	it('maps standard C# GUID text to exact serialized bytes and resolves public names case-insensitively', () => {
		const definition = registry.getChip('Player Get Is Grounded')!
		expect(registry.getChip(groundedGuid.toUpperCase())).toBe(definition)
		expect(registry.getChip(groundedType)).toBe(definition)
		expect(registry.getChip(`chip:${groundedType}`)).toBe(definition)
		expect(registry.getChip('player get is grounded')).toBe(definition)
		expect(definition.runtimeGuid).toBe(groundedGuid)
		expect(definition.typeId).toBe(groundedType)
		expect(registry.getChip('Event Receiver')!.typeId).toBe('cb3c538b3a641d49982c94417ce99954')
		expect(
			references.chips.some((chip) => chip.typeId === registry.getChip('Event Receiver')!.typeId)
		).toBe(true)
	})
	it('provides authoritative ordered data/exec ports, type constraints and explicit missing defaults', () => {
		const chip = registry.getChip('Player Get Is Grounded')!
		expect(chip.inputs).toMatchObject([
			{ name: 'Player', type: 'Player', direction: 'input', group: 0, order: 0, execution: false },
		])
		expect(chip.outputs.map((port: any) => [port.order, port.name, port.type])).toEqual([
			[0, 'Is Grounded', 'bool'],
			[1, 'Time Since Last Grounded', 'float'],
			[2, 'Surface Object', 'Rec Room Object'],
			[3, 'Surface Normal', 'Vector3'],
		])
		expect(registry.getChip('Event Receiver')!.execOutputs).toMatchObject([
			{ order: 0, type: 'exec', direction: 'output' },
		])
		const add = registry.getChip('Add')!
		expect(add.groups[0].typeParameters).toEqual({ T: '(int | float | Vector3)' })
		expect(add.inputs[0].generic).toBe(true)
		expect(add.completeness.missing).toContain('concreteGenericBindings')
		expect(chip.completeness.missing).toContain('chipDefaults')
		expect(chip.instantiation.supportedFromDefinitionAlone).toBe(false)
		expect(chip.inputs[0]).not.toHaveProperty('defaultValue')
	})
	it('searches capabilities absent from the target room and supports deterministic bounded pagination', () => {
		const workspace = empty()
		expect(workspace.chipDefinition('Player Right Hand Position').totalInstances).toBe(0)
		expect(
			workspace.chipDefinition('Player Set Physics Velocity').globalDefinition!.inputs.length
		).toBeGreaterThan(0)
		expect(
			registry.searchChips('grounded').definitions.some((v) => v.typeId === groundedType)
		).toBe(true)
		expect(
			registry
				.searchChips('hand velocity')
				.definitions.some((v) => v.name === 'Player Left Hand Velocity')
		).toBe(true)
		expect(registry.searchTypes('Player').total).toBeGreaterThan(0)
		expect(registry.getType('Float')!.name).toBe('float')
		expect(registry.getType('Bool')!.name).toBe('bool')
		expect(registry.getType('Vector3')!.provenance).toContain('official-catalog')
		expect(registry.searchDefinitions('Sync', 'variables').total).toBeGreaterThan(0)
		const first = registry.searchChips('*', 0, 3),
			second = registry.searchChips('*', 3, 3)
		expect(first.nextOffset).toBe(3)
		expect([...first.definitions, ...second.definitions]).toEqual(
			registry.searchChips('*', 0, 6).definitions
		)
		expect(registry.searchChips('*', 10000, 3).definitions).toEqual([])
		expect(() => registry.searchChips('*', -1)).toThrow('pagination')
		expect(() => registry.searchTypes('*', 0, 51)).toThrow('pagination')
		expect(() => registry.searchDefinitions('')).toThrow('query')
		expect(registry.getChip('Invented Double Jump Chip')).toBeNull()
		expect(registry.getType('InventedPlayerMotionType')).toBeNull()
	})
	it('exposes actual configuration field numbers, enums and schema defaults without treating them as chip GUIDs', () => {
		const node = registry.getType('circuits_v2.CircuitNodeData')!
		expect(node.fields.find((field: any) => field.name === 'variable_node_data')).toMatchObject({
			fieldNumber: 103,
			type: 'circuits_v2.VariableNodeData',
		})
		expect(
			registry
				.getType('circuits_v2.VariableNodeData')!
				.fields.find((field: any) => field.name === 'memory_type')
		).toMatchObject({ type: 'circuits_v2.MemoryType', wireDefault: 0 })
		expect(registry.getType('circuits_v2.MemoryType')!.enumValues).toEqual({
			Instance: 0,
			Sync: 1,
			Cloud: 2,
			None: -1,
		})
		expect(registry.getType('circuits.TypeKind')!.enumValues.Exec).toBe(5)
		expect(registry.getType('core.GuidData')).not.toBeNull()
		expect(registry.getChip('103')).toBeNull()
	})
	it('retains multiple configured event-port variants and scopes observed event identities to reference saves', () => {
		const variants = registry.getChipVariants('Event Receiver', 0, 5)
		expect(variants.total).toBeGreaterThan(5)
		expect(variants.variants).toHaveLength(5)
		const outputNames = variants.variants.map(
			(v) => v.configuration.event_receiver_node_data.node_desc.name
		)
		expect(new Set(outputNames).size).toBeGreaterThan(1)
		const events = registry.searchDefinitions('*', 'events', 0, 50)
		const observed = events.definitions.find((entry) => entry.scope === 'reference-save')!
		const event = registry.getEvent(observed.id)!
		expect(event.scope).toBe('reference-save')
		expect(event.completeness.missing).toContain('targetRoomEventBinding')
		expect(event.inputs).toBeDefined()
		const sample = variants.variants[0]
		expect(sample.inputGroups[0]).not.toHaveProperty('inputs')
		expect(sample.sources).toHaveLength(1)
	})
	it('records verified source hashes, pinned commit and license for reproducible generation', () => {
		const source = registry.info.provenance.officialCatalog
		expect(source.commit).toBe('d4dc2523506862a46844e4c6064bcc2cbc2a08bb')
		expect(source.license).toBe('MIT')
		const hash = (path: string) =>
			createHash('sha256')
				.update(readFileSync(new URL(path, import.meta.url)))
				.digest('hex')
		expect(source.sha256).toBe(hash('../../discovery/cv2-schema/upstream/circuitsv2.full.json'))
		expect(source.paletteSha256).toBe(hash('../../discovery/cv2-schema/upstream/circuitsv2.json'))
		expect(registry.info.provenance.protobufSha256).toBe(
			hash('../../discovery/cv2-schema/RR_ProtobufDefinitions.zip')
		)
		for (const saved of references.sources)
			expect(saved.sha256).toBe(hash(`../../../${saved.source}`))
	})
	it('does not let global definitions authorize changing chip types or inventing serialized templates', () => {
		const bytes = roomType
			.encode(
				roomType.fromObject({
					circuit_v2_data: {
						root: {
							graph_id: guid('11'.repeat(16)),
							node_datas: [
								{
									node_id: guid('22'.repeat(16)),
									node_type: guid('33'.repeat(16)),
									node_name: 'String variable',
								},
							],
						},
					},
				})
			)
			.finish()
		const workspace = new RoomWorkspace(new RoomDocument(bytes))
		const [path, file] = [...workspace.files][0]!
		workspace.patch(path, 0, [{ old: '33'.repeat(16), new: groundedType }])
		expect(workspace.chipDefinition(groundedType).globalDefinition!.name).toBe(
			'Player Get Is Grounded'
		)
		expect(() => workspace.compile()).toThrow('known template')
		expect(file.text).toContain(groundedType)
	})
	it('makes the global tools usable throughout an empty-room model run with bounded context', async () => {
		const workspace = empty(),
			calls: any[] = []
		const steps = [
			['get_registry_info', {}],
			['search_chips', { query: 'grounded', offset: 0, limit: 5 }],
			['get_chip_definition', { type: 'Player Get Is Grounded' }],
			['get_type_definition', { type: 'Player' }],
			['search_definitions', { query: 'memory', category: 'variables', offset: 0, limit: 5 }],
			['get_chip_variants', { type: 'Event Receiver', offset: 0, limit: 2 }],
			['get_definition', { id: 'schema:circuits_v2.MemoryType' }],
			['abort', { reason: 'No serialized target-room creation template is available' }],
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
		await expect(
			runAgent(
				workspace,
				'Build double jump',
				'key',
				() => {},
				async () => {},
				Date.now() + 100000
			)
		).rejects.toThrow('No serialized target-room')
		expect(calls).toHaveLength(steps.length)
		const outputs = calls.slice(1).map((call) => JSON.parse(call.input.at(-1).output))
		expect(outputs.every((output) => !output.error)).toBe(true)
		expect(outputs[1].definitions.some((chip: any) => chip.typeId === groundedType)).toBe(true)
		expect(outputs[2].globalDefinition.outputs[0].type).toBe('bool')
		expect(outputs[2].totalInstances).toBe(0)
		expect(calls[0].instructions).toContain('Always search')
		expect(JSON.stringify(calls[0].input)).not.toContain('NodeDescs')
	})
})
