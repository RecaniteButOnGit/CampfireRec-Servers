import { LANGUAGE, parse, serialize } from './language'
import {
	checkRecord,
	decode,
	definition,
	edgeType,
	fields,
	guid,
	id,
	join,
	messageField,
	nodeType,
	root,
	stable,
	update,
} from './protobuf'
import { equalBytes, nodeId, nodeTypeId, RoomDocument, sourceId, targetId } from './room'

import type { Script, ScriptNode } from './language'
import type { RecordData } from './protobuf'
import type { SavedGraph } from './room'

type File = { original: string; text: string; revision: number; script: Script }
type Node = { graph: string; data: RecordData; bytes: Uint8Array }
export type Diff = {
	files: string[]
	chipsChanged: number
	chipsCreated: number
	chipsRemoved: number
	connectionsAdded: number
	connectionsRemoved: number
	patch: string
}
export type Compilation = {
	bytes: Uint8Array
	graphs: Map<string, Uint8Array>
	diff: Diff
	touchedNodes: Set<string>
	topologyChanged: boolean
}

const OMIT = new Set([
	'node_id',
	'DEPRECATED_node_id',
	'node_type',
	'DEPRECATED_node_type',
	'transform_data',
])
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const editableData = (data: RecordData) =>
	Object.fromEntries(Object.entries(data).filter(([key]) => !OMIT.has(key)))
const edgeKey = (data: RecordData) =>
	`${sourceId(data)}:${data.src_port_group_id ?? 0}:${data.src_port_id ?? 0}>${targetId(data)}:${data.dst_port_group_id ?? 0}:${data.dst_port_id ?? 0}`

function descriptions(data: RecordData): RecordData[] {
	for (const value of Object.values(data)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			if (value.node_desc) return [value.node_desc]
			if (value.node_descs) return value.node_descs
		}
	}
	return []
}

/** Metadata is instance-specific: two Event Receiver chips can have different ports. */
function port(
	node: RecordData,
	direction: 'inputs' | 'outputs',
	group: number,
	index: number
): RecordData | null {
	if (!Number.isInteger(group) || !Number.isInteger(index) || group < 0 || index < 0)
		throw new Error('Port indices must be nonnegative integers')
	const desc = descriptions(node)[group]
	let descIndex = index
	if (direction === 'inputs') {
		const indices: number[] = node.node_groups?.[group]?.first_input_indices ?? []
		if (indices.length) {
			descIndex = indices.findLastIndex((start) => start <= index)
			if (descIndex < 0 || index >= (node.node_groups?.[group]?.inputs?.length ?? 0))
				throw new Error(`Input port ${group}.${index} does not exist`)
		}
	}
	if (desc && !desc[direction]?.[descIndex])
		throw new Error(`${direction} port ${group}.${index} does not exist`)
	return desc?.[direction]?.[descIndex]?.type ?? null
}
function compatible(source: RecordData, target: RecordData): boolean {
	if (stable(source) === stable(target)) return true
	if ((target.kind ?? 'Any') === 'Any') return (source.kind ?? 'Any') !== 'Exec'
	if (source.kind === 'Class' && target.kind === 'Class')
		return (source.class_type?.baseClasses ?? []).some((base: RecordData) =>
			compatible(base, target)
		)
	return false
}
function immutableOpaque(before: unknown, after: unknown, path: string): void {
	const collect = (value: any, location: string, result: Map<string, string>) => {
		if (!value || typeof value !== 'object') return
		for (const [key, child] of Object.entries(value)) {
			if (key === 'backing_bytes') result.set(`${location}.${key}`, stable(child))
			else collect(child, `${location}.${key}`, result)
		}
	}
	const oldBytes = new Map<string, string>(),
		newBytes = new Map<string, string>()
	collect(before, path, oldBytes)
	collect(after, path, newBytes)
	if (stable([...oldBytes]) !== stable([...newBytes]))
		throw new Error(`${path}: signal backing_bytes encoding is opaque; changing it is unsupported`)
}

function validateInputs(before: RecordData, after: RecordData): void {
	const oldGroups = before.node_groups ?? [],
		newGroups = after.node_groups ?? []
	if (oldGroups.length !== newGroups.length)
		throw new Error('Input port group count cannot be changed')
	const signalKinds: Record<string, string> = {
		DEPRECATED_backing_bool: 'Boolean',
		DEPRECATED_backing_float: 'Single',
		DEPRECATED_int32_backing_bytes: 'Int32',
		backing_string: 'String',
	}
	for (let group = 0; group < oldGroups.length; group++) {
		const oldGroup = oldGroups[group],
			newGroup = newGroups[group]
		if (
			stable(oldGroup.first_input_indices) !== stable(newGroup.first_input_indices) ||
			(oldGroup.inputs?.length ?? 0) !== (newGroup.inputs?.length ?? 0)
		)
			throw new Error(`Input ports in group ${group} cannot be invented, removed or reordered`)
		for (let index = 0; index < (oldGroup.inputs?.length ?? 0); index++) {
			const oldSignal = oldGroup.inputs[index]?.default_signal_value ?? {},
				signal = newGroup.inputs[index]?.default_signal_value ?? {}
			if (stable(oldSignal) === stable(signal)) continue
			if (Object.hasOwn(oldSignal, 'backing_bytes'))
				throw new Error(`Input ${group}.${index}: signal backing_bytes encoding is opaque`)
			if (oldSignal.DEPRECATED_type_kind !== signal.DEPRECATED_type_kind)
				throw new Error(`Input ${group}.${index}: serialized signal type cannot be changed`)
			const declared = port(after, 'inputs', group, index)
			const oldKinds = Object.keys(oldSignal).filter((key) => signalKinds[key]),
				newKinds = Object.keys(signal).filter((key) => signalKinds[key])
			if (!declared && stable(oldKinds) !== stable(newKinds))
				throw new Error(
					`Input ${group}.${index}: type is unavailable; preserve the existing signal representation`
				)
			if (declared && newKinds.some((key) => signalKinds[key] !== declared.kind))
				throw new Error(
					`Input ${group}.${index}: constant expects ${declared.kind}, received ${newKinds.map((key) => signalKinds[key]).join(', ')}`
				)
		}
	}
}

export class RoomWorkspace {
	readonly files = new Map<string, File>()
	readonly nodes = new Map<string, Node>()
	readonly newIds = new Map<string, string>()
	readonly knownReferences = new Set<string>()
	readonly referencesByField = new Map<string, Set<string>>()
	version = 0
	private readonly validated = new Map<string, number>()
	private roomValidated = -1
	private diffInspected = -1
	constructor(readonly document: RoomDocument) {
		for (const graph of document.graphs.values()) {
			const rawNodes = fields(graph.bytes).filter((f) => f.number === 11)
			for (const raw of rawNodes) {
				const data = decode(nodeType, raw.data),
					key = nodeId(data)
				if (this.nodes.has(key)) throw new Error(`Duplicate chip ID ${key}`)
				this.nodes.set(key, { graph: graph.id, data, bytes: raw.data })
			}
		}
		const references = (value: unknown, ids: Set<string>, field = '') => {
			if (!value || typeof value !== 'object') return
			if (!Array.isArray(value) && typeof (value as RecordData).value === 'string') {
				try {
					const key = id(value as RecordData)
					ids.add(key)
					const values = this.referencesByField.get(field) ?? new Set<string>()
					values.add(key)
					this.referencesByField.set(field, values)
				} catch {
					/* Not every value is a GUID. */
				}
			}
			for (const [key, child] of Object.entries(value))
				references(child, ids, /^\d+$/.test(key) ? field : key)
		}
		references(
			decode(root.lookupType('rec_room.PersistedRoomData'), document.bytes),
			this.knownReferences
		)
		for (const objectId of document.objectIds) this.knownReferences.add(objectId)
		for (const graph of document.graphs.values()) this.decompile(graph)
	}

	private decompile(graph: SavedGraph): void {
		const chips: RecordData[] = graph.data.node_datas ?? [],
			edges: RecordData[] = graph.data.edges ?? []
		const parents = new Map(chips.map((chip) => [nodeId(chip), nodeId(chip)]))
		const find = (key: string): string => {
			let current = key
			while (parents.get(current) !== current) {
				if (!parents.has(current))
					throw new Error(`Graph ${graph.id}: wire references missing chip ${key}`)
				current = parents.get(current)!
			}
			return current
		}
		for (const edge of edges) {
			const a = find(sourceId(edge)),
				b = find(targetId(edge))
			if (a !== b) parents.set(a < b ? b : a, a < b ? a : b)
		}
		const components = new Map<string, Script>()
		for (const chip of chips) {
			const component = find(nodeId(chip))
			const script = components.get(component) ?? {
				graph: graph.id,
				component,
				nodes: [],
				edges: [],
			}
			script.nodes.push({
				id: nodeId(chip),
				type: nodeTypeId(chip),
				data: editableData(chip),
				line: 0,
			})
			components.set(component, script)
		}
		const keys = new Map<string, number>()
		for (const edge of edges) {
			const key = edgeKey(edge),
				occurrence = keys.get(key) ?? 0
			keys.set(key, occurrence + 1)
			components
				.get(find(sourceId(edge)))!
				.edges.push({ key: `${key}#${occurrence}`, data: edge, line: 0 })
		}
		for (const [component, script] of [...components].sort(([a], [b]) => compare(a, b))) {
			const name = [...script.nodes]
				.sort((a, b) => compare(a.id, b.id))
				.map((node) => node.data.node_name || node.data.comment_node_data?.text)
				.find((value) => typeof value === 'string' && value.trim())
			const slug =
				typeof name === 'string'
					? name
							.trim()
							.replace(/[^a-zA-Z0-9_-]/g, '_')
							.slice(0, 40) + '_'
					: 'graph_'
			const path = `/room/graphs/${slug}${graph.id}_${component}.cv2`,
				text = serialize(script)
			this.files.set(path, { original: text, text, revision: 0, script: parse(text, path) })
		}
	}

	list(offset = 0, limit = 30) {
		return {
			total: this.files.size,
			graphs: [...this.files]
				.sort(([a], [b]) => compare(a, b))
				.slice(offset, offset + Math.min(limit, 100))
				.map(([path, file]) => ({
					path,
					chips: file.script.nodes.length,
					revision: file.revision,
					changed: file.original !== file.text,
				})),
		}
	}
	read(path: string, start = 1, count = 100) {
		const file = this.file(path),
			lines = file.text.split('\n')
		return {
			path,
			revision: file.revision,
			totalLines: lines.length,
			text: lines
				.slice(start - 1, start - 1 + Math.min(count, 200))
				.map((line, index) => `${start + index}: ${line}`)
				.join('\n'),
		}
	}
	search(query: string) {
		if (!query || query.length > 200) throw new Error('Search query must contain 1–200 characters')
		const hits: Array<{ path: string; line: number; text: string }> = []
		for (const [path, file] of this.files)
			for (const [index, line] of file.text.split('\n').entries())
				if (line.toLowerCase().includes(query.toLowerCase())) {
					hits.push({ path, line: index + 1, text: line.slice(0, 1200) })
					if (hits.length === 40) return hits
				}
		return hits
	}
	private file(path: string): File {
		const file = this.files.get(path)
		if (!file) throw new Error(`Unknown virtual file ${path}`)
		return file
	}
	patch(path: string, revision: number, edits: Array<{ old: string; new: string }>) {
		const file = this.file(path)
		if (file.revision !== revision)
			throw new Error(`${path}: stale revision; read the changed section again`)
		if (!edits.length || edits.length > 30) throw new Error('Patch requires 1–30 edits')
		let next = file.text
		for (const edit of edits) {
			if (
				!edit.old ||
				!next.includes(edit.old) ||
				next.indexOf(edit.old) !== next.lastIndexOf(edit.old)
			)
				throw new Error(`${path}: old patch text must match exactly once`)
			next = next.replace(edit.old, () => edit.new)
			if (next.length > 1024 * 1024) throw new Error('Script exceeds 1 MiB')
		}
		const script = parse(next, path)
		if (script.graph !== file.script.graph || script.component !== file.script.component)
			throw new Error('Graph/component identities are immutable')
		file.text = next
		file.script = script
		file.revision++
		this.version++
		return { path, revision: file.revision }
	}

	chipDefinition(type: string) {
		const examples = [...this.nodes].filter(([, node]) => nodeTypeId(node.data) === type)
		if (!examples.length) throw new Error(`Chip type ${type} is not known in this save`)
		return {
			type,
			schema: definition(nodeType),
			instances: examples.slice(0, 8).map(([key, node]) => ({
				id: key,
				name: node.data.node_name ?? '',
				descriptions: descriptions(node.data),
				inputGroups: node.data.node_groups ?? [],
				configuration: editableData(node.data),
			})),
			totalInstances: examples.length,
		}
	}
	typeDefinition(name: string) {
		const type = root.lookup(name)
		if (!type) throw new Error(`Unknown protobuf type ${name}`)
		return type.toJSON()
	}
	docs(query: string) {
		const docs = {
			'/room/docs/language.md': LANGUAGE,
			'/room/docs/types.md': stable(root.lookupEnum('circuits.TypeKind').values),
			'/room/docs/chips.md':
				'Chip definitions are generated from this save. Search chip names/metadata with search_graphs and retrieve actual instance definitions with get_chip_definition. A GUID identifies a type; protobuf fields alone do not define its behavior.',
		}
		return Object.entries(docs)
			.flatMap(([path, text]) =>
				text
					.split('\n')
					.flatMap((line, index) =>
						line.toLowerCase().includes(query.toLowerCase())
							? [{ path, line: index + 1, text: line }]
							: []
					)
			)
			.slice(0, 40)
	}

	private resolveId(key: string): string {
		if (!key.startsWith('new:')) return key
		let resolved = this.newIds.get(key)
		if (!resolved) {
			do {
				resolved = crypto.randomUUID().replaceAll('-', '')
			} while (this.knownReferences.has(resolved) || [...this.newIds.values()].includes(resolved))
			this.newIds.set(key, resolved)
		}
		return resolved
	}

	compile(): Compilation {
		const parsed = [...this.files].map(([path, file]) => ({
			path,
			file,
			script: parse(file.text, path),
		}))
		const nodes = new Map<
			string,
			{ script: ScriptNode; data: RecordData; raw: Uint8Array; graph: string }
		>()
		const touchedNodes = new Set<string>(),
			graphs = new Map<string, Uint8Array>()
		let topologyChanged = false
		for (const { path, script } of parsed)
			for (const node of script.nodes) {
				const fail = (text: string): never => {
					throw new Error(`${path}:${node.line}: ${text}`)
				}
				if (nodes.has(node.id)) fail('duplicate chip ID across virtual graphs')
				const original = this.nodes.get(node.id),
					template = node.template ? this.nodes.get(node.template) : undefined
				if (!original && !node.id.startsWith('new:'))
					fail('existing chip IDs cannot be changed or fabricated')
				if (original && original.graph !== script.graph)
					fail('chips cannot be moved between saved graph containers')
				const base = original ?? template
				if (!base || nodeTypeId(base.data) !== node.type)
					fail('chip type must match a known template; existing types are immutable')
				if (
					!original &&
					(base!.data.graph_node_data || base!.data.invention_data || base!.data.board_bus_data)
				)
					fail('new chips cannot clone graph/object/invention bindings')
				if (Object.keys(node.data).some((key) => OMIT.has(key)))
					fail('chip identity, type and layout are managed by the compiler')
				const next: RecordData = { ...base!.data, ...node.data }
				if (original)
					for (const key of Object.keys(editableData(base!.data)))
						if (!Object.hasOwn(node.data, key)) delete next[key]
				if (!original) {
					topologyChanged = true
					if (!base!.data.node_id) fail('new chips require typed GUID serialization')
					next.node_id = guid(this.resolveId(node.id))
					delete next.DEPRECATED_node_id
					const position = base!.data.transform_data?.local_position ?? {}
					next.transform_data = {
						...base!.data.transform_data,
						local_position: { ...position, x: (position.x ?? 0) + 0.3 * (this.newIds.size + 1) },
					}
				}
				try {
					// The storage schema lists payloads for every chip type, but does not
					// map their GUIDs to payload variants. Retain the verified variant.
					for (const key of new Set([...Object.keys(base!.data), ...Object.keys(next)]))
						if (
							key.startsWith('DEPRECATED_') &&
							!OMIT.has(key) &&
							stable(base!.data[key]) !== stable(next[key])
						)
							throw new Error(`${key}: deprecated chip port metadata is opaque`)
					for (const field of nodeType.fieldsArray) {
						if (field.type === 'bytes' || ['node_groups', ...OMIT].includes(field.name)) continue
						if (
							field.resolvedType &&
							'fields' in field.resolvedType &&
							Object.hasOwn(base!.data, field.name) !== Object.hasOwn(next, field.name)
						)
							throw new Error(
								`${field.name}: chip configuration variant cannot be added or removed`
							)
					}
					immutableOpaque(base!.data, next, 'chip')
					validateInputs(base!.data, next)
					if (stable(descriptions(base!.data)) !== stable(descriptions(next)))
						throw new Error('Port definitions cannot be fabricated or rewritten')
					this.validateReferences(base!.data, next, script.graph)
					checkRecord(nodeType, next)
				} catch (error) {
					fail(error instanceof Error ? error.message : 'Invalid chip')
				}
				const raw = update(nodeType, base!.bytes, next)
				nodes.set(node.id, { script: node, data: next, raw, graph: script.graph })
				if (!original || !equalBytes(raw, original.bytes)) touchedNodes.add(node.id)
			}
		for (const [key] of this.nodes)
			if (!nodes.has(key)) {
				touchedNodes.add(key)
				topologyChanged = true
			}
		const resolvedNodes = new Map([...nodes.values()].map((node) => [nodeId(node.data), node]))
		for (const graph of this.document.graphs.values()) {
			const graphScripts = parsed.filter((item) => item.script.graph === graph.id)
			const originalEdges = graphScripts.flatMap(({ file }) => parse(file.original, '').edges)
			const edges = graphScripts.flatMap(({ path, script }) =>
				script.edges.map((edge) => ({ path, edge }))
			)
			const edgeMap = new Map<string, Uint8Array>(),
				seenInputs = new Map<string, boolean>()
			const rawEdges = fields(graph.bytes).filter((f) => f.number === 5)
			const savedEdgeKeys = new Map<string, number>()
			const originalRaw = new Map<string, Uint8Array>()
			for (const raw of rawEdges) {
				const key = edgeKey(decode(edgeType, raw.data)),
					n = savedEdgeKeys.get(key) ?? 0
				savedEdgeKeys.set(key, n + 1)
				originalRaw.set(`${key}#${n}`, raw.data)
			}
			for (const { path, edge } of edges) {
				const fail = (text: string): never => {
					throw new Error(`${path}:${edge.line}: connection error: ${text}`)
				}
				if (edgeMap.has(edge.key)) fail('duplicate wire key across scripts')
				const before = originalEdges.find((e) => e.key === edge.key)
				if (!before && !/^new:[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(edge.key))
					fail('new wires require new:label keys')
				const next = structuredClone(edge.data)
				for (const side of ['src_node_id', 'dst_node_id'])
					if (next[side]?.value?.startsWith('new:'))
						next[side] = guid(this.resolveId(next[side].value))
				let source: string, target: string
				try {
					source = sourceId(next)
					target = targetId(next)
					checkRecord(edgeType, next)
				} catch (error) {
					fail(error instanceof Error ? error.message : 'Invalid endpoints')
				}
				const sourceNode = resolvedNodes.get(source!),
					targetNode = resolvedNodes.get(target!)
				if (
					!sourceNode ||
					!targetNode ||
					sourceNode.graph !== graph.id ||
					targetNode.graph !== graph.id
				)
					fail('endpoints must resolve within this saved graph')
				const changed = !before || stable(before.data) !== stable(next)
				if (changed) {
					topologyChanged = true
					if (Object.keys(next).some((key) => key.startsWith('DEPRECATED_')))
						fail(
							'legacy GUID port wiring is opaque; new connections require modern typed port indices'
						)
					try {
						const output = port(
							sourceNode!.data,
							'outputs',
							next.src_port_group_id ?? 0,
							next.src_port_id ?? 0
						)
						const input = port(
							targetNode!.data,
							'inputs',
							next.dst_port_group_id ?? 0,
							next.dst_port_id ?? 0
						)
						if (!output || !input)
							throw new Error(
								'port type is unavailable in save metadata; cannot safely add this connection'
							)
						if (!compatible(output, input))
							throw new Error(
								`${stable(output)} output is incompatible with ${stable(input)} input`
							)
					} catch (error) {
						fail(error instanceof Error ? error.message : 'Invalid ports')
					}
				}
				const inputKey = `${target!}:${next.dst_port_group_id ?? 0}:${next.dst_port_id ?? 0}`
				// Preserve existing execution fan-in; new data fan-in is ambiguous.
				if (
					seenInputs.has(inputKey) &&
					(changed || seenInputs.get(inputKey)) &&
					port(targetNode!.data, 'inputs', next.dst_port_group_id ?? 0, next.dst_port_id ?? 0)
						?.kind !== 'Exec'
				)
					fail('input already has a data connection')
				seenInputs.set(inputKey, changed || seenInputs.get(inputKey) === true)
				edgeMap.set(
					edge.key,
					before
						? update(edgeType, originalRaw.get(edge.key)!, next)
						: update(edgeType, new Uint8Array(), next)
				)
			}
			if (originalEdges.some((edge) => !edgeMap.has(edge.key))) topologyChanged = true
			const graphNodes = [...nodes.values()].filter((node) => node.graph === graph.id)
			const rawNodeMap = new Map(graphNodes.map((node) => [nodeId(node.data), node.raw]))
			const remainingNodes = new Map(rawNodeMap),
				remainingEdges = new Map(edgeMap)
			const keyOccurrences = new Map<string, number>()
			const parts = fields(graph.bytes).flatMap((field) => {
				if (field.number === 11) {
					const key = nodeId(decode(nodeType, field.data)),
						raw = remainingNodes.get(key)
					remainingNodes.delete(key)
					return raw ? [equalBytes(raw, field.data) ? field.raw : messageField(11, raw)] : []
				}
				if (field.number === 5) {
					const key = edgeKey(decode(edgeType, field.data)),
						n = keyOccurrences.get(key) ?? 0
					keyOccurrences.set(key, n + 1)
					const raw = remainingEdges.get(`${key}#${n}`)
					remainingEdges.delete(`${key}#${n}`)
					return raw ? [equalBytes(raw, field.data) ? field.raw : messageField(5, raw)] : []
				}
				return [field.raw]
			})
			for (const [, raw] of [...remainingNodes].sort(([a], [b]) => compare(a, b)))
				parts.push(messageField(11, raw))
			for (const [, raw] of [...remainingEdges].sort(([a], [b]) => compare(a, b)))
				parts.push(messageField(5, raw))
			const next = join(parts)
			if (!equalBytes(next, graph.bytes)) graphs.set(graph.id, next)
		}
		if (topologyChanged && this.document.hasEntities)
			throw new Error(
				'This save has authoritative entity topology. Creating/removing chips or connections requires an entity topology adapter; field edits are supported.'
			)
		const bytes = this.document.compile(graphs)
		new RoomDocument(bytes)
		return { bytes, graphs, diff: this.diff(), touchedNodes, topologyChanged }
	}

	private validateReferences(before: RecordData, next: RecordData, graphId: string): void {
		const walk = (oldValue: any, value: any, path: string) => {
			if (!value || typeof value !== 'object') return
			if (
				!Array.isArray(value) &&
				typeof value.value === 'string' &&
				path.endsWith('_id') &&
				path !== 'chip.node_id' &&
				stable(oldValue) !== stable(value)
			) {
				const key = id(value)
				const field = path.split('.').at(-1)!
				if (
					!this.referencesByField.get(field)?.has(key) &&
					!(field.includes('object') && this.document.objectIds.has(key))
				)
					throw new Error(`${path}: reference does not resolve to a known ${field} in this save`)
			}
			for (const [key, child] of Object.entries(value))
				walk(oldValue?.[key], child, `${path}.${key}`)
		}
		walk(before, next, 'chip')
		if (
			next.variable_node_data &&
			stable(before.variable_node_data) !== stable(next.variable_node_data)
		) {
			if (
				![...this.nodes.values()].some(
					(node) =>
						node.graph === graphId &&
						node.data.variable_node_data?.name === next.variable_node_data.name &&
						stable(node.data.variable_node_data?.memory_type) ===
							stable(next.variable_node_data.memory_type)
				)
			)
				throw new Error(
					'Variable reference does not resolve to a known variable with this memory type in this graph'
				)
		}
	}

	diff(): Diff {
		const diff: Diff = {
			files: [],
			chipsChanged: 0,
			chipsCreated: 0,
			chipsRemoved: 0,
			connectionsAdded: 0,
			connectionsRemoved: 0,
			patch: '',
		}
		const parts: string[] = []
		for (const [path, file] of this.files) {
			if (file.text === file.original) continue
			diff.files.push(path)
			const before = parse(file.original, path),
				next = parse(file.text, path)
			parts.push(`--- ${path}\n+++ ${path}`)
			for (const node of before.nodes) {
				const after = next.nodes.find((n) => n.id === node.id)
				if (!after) {
					diff.chipsRemoved++
					parts.push(`- chip ${node.id}`)
					continue
				}
				if (stable(node.data) !== stable(after.data) || node.type !== after.type) {
					diff.chipsChanged++
					parts.push(`@@ chip ${node.id} @@`)
					for (const key of [
						...new Set([...Object.keys(node.data), ...Object.keys(after.data)]),
					].sort())
						if (stable(node.data[key]) !== stable(after.data[key]))
							parts.push(
								`- ${key} = ${stable(node.data[key])}\n+ ${key} = ${stable(after.data[key])}`
							)
				}
			}
			for (const node of next.nodes)
				if (!before.nodes.some((n) => n.id === node.id)) {
					diff.chipsCreated++
					parts.push(
						`+ chip ${node.id} type ${node.type} template ${node.template}\n+ configuration ${stable(node.data)}`
					)
				}
			for (const edge of before.edges)
				if (!next.edges.some((e) => e.key === edge.key && stable(e.data) === stable(edge.data))) {
					diff.connectionsRemoved++
					parts.push(`- wire ${edge.key} = ${stable(edge.data)}`)
				}
			for (const edge of next.edges)
				if (!before.edges.some((e) => e.key === edge.key && stable(e.data) === stable(edge.data))) {
					diff.connectionsAdded++
					parts.push(`+ wire ${edge.key} = ${stable(edge.data)}`)
				}
		}
		diff.patch = parts.join('\n')
		return diff
	}
	validateGraph(path: string) {
		this.file(path)
		this.compile()
		this.validated.set(path, this.version)
		return { valid: true, path, version: this.version }
	}
	validateRoom() {
		this.compile()
		this.roomValidated = this.version
		return { valid: true, version: this.version }
	}
	inspectDiff() {
		const diff = this.diff()
		if (JSON.stringify(diff).length > 60000)
			throw new Error('Diff exceeds the review budget; reduce the change scope before finishing')
		this.diffInspected = this.version
		return diff
	}
	finish(): Compilation {
		const changed = this.diff().files
		if (!changed.length)
			throw new Error(
				'No edits were made. Use abort if the request requires no changes or cannot be completed.'
			)
		if (
			changed.some((path) => this.validated.get(path) !== this.version) ||
			this.roomValidated !== this.version ||
			this.diffInspected !== this.version
		)
			throw new Error(
				'After the last patch, validate every changed graph, validate_room and get_diff before finish'
			)
		const compiled = this.compile()
		if (!compiled.graphs.size) throw new Error('The patch made no actual CV2 changes')
		return compiled
	}

	/** Rebase only when each entire edited component, its layout and graph metadata match. */
	rebase(latest: RoomWorkspace, compiled: Compilation): Uint8Array {
		const replacements = new Map<string, Uint8Array>()
		if (!equalBytes(this.rootMetadataBytes(), latest.rootMetadataBytes()))
			throw new Error('Save conflict: CV2 version, global bindings or registries changed')
		for (const key of compiled.touchedNodes) {
			const checkObjectReferences = (value: any) => {
				if (!value || typeof value !== 'object') return
				if (typeof value.value === 'string') {
					let reference: string | undefined
					try {
						reference = id(value)
					} catch {
						/* Not a serialized GUID. */
					}
					if (
						reference &&
						this.document.objectIds.has(reference) &&
						!latest.document.objectIds.has(reference)
					)
						throw new Error(`Save conflict: referenced object ${reference} was removed`)
				}
				for (const child of Object.values(value)) checkObjectReferences(child)
			}
			checkObjectReferences(this.nodes.get(key)?.data)
		}
		for (const [graphId, edited] of compiled.graphs) {
			const base = this.document.graphs.get(graphId),
				current = latest.document.graphs.get(graphId)
			if (!base || !current) throw new Error(`Save conflict: graph ${graphId} was removed`)
			if (equalBytes(base.bytes, current.bytes)) {
				replacements.set(graphId, edited)
				continue
			}
			if (compiled.topologyChanged)
				throw new Error(`Save conflict: graph ${graphId} topology changed`)
			const editedIds = new Set(
				[...compiled.touchedNodes].filter((key) => this.nodes.get(key)?.graph === graphId)
			)
			const affected = [...this.files.values()].filter(
				(file) =>
					file.script.graph === graphId && file.script.nodes.some((node) => editedIds.has(node.id))
			)
			const componentIds = new Set(
				affected.flatMap((file) => parse(file.original, '').nodes.map((node) => node.id))
			)
			for (const key of componentIds)
				if (
					!latest.nodes.has(key) ||
					!equalBytes(this.nodes.get(key)!.bytes, latest.nodes.get(key)!.bytes)
				)
					throw new Error(`Save conflict: component containing chip ${key} changed`)
			const baseEdges = (base.data.edges ?? []).filter(
				(edge: RecordData) => componentIds.has(sourceId(edge)) || componentIds.has(targetId(edge))
			)
			const currentEdges = (current.data.edges ?? []).filter(
				(edge: RecordData) => componentIds.has(sourceId(edge)) || componentIds.has(targetId(edge))
			)
			if (stable(baseEdges) !== stable(currentEdges))
				throw new Error(`Save conflict: connections in graph ${graphId} changed`)
			const metadata = (data: RecordData) =>
				Object.fromEntries(
					Object.entries(data).filter(
						([key]) => !['node_datas', 'edges', 'child_graphs'].includes(key)
					)
				)
			if (
				stable(metadata(base.data)) !== stable(metadata(current.data)) ||
				(this.document.hasEntities && !equalBytes(this.entityBytes(), latest.entityBytes()))
			)
				throw new Error(`Save conflict: graph ${graphId} metadata changed`)
			const editedNodes = new Map(
				fields(edited)
					.filter((field) => field.number === 11)
					.map((field) => [nodeId(decode(nodeType, field.data)), field.data])
			)
			replacements.set(
				graphId,
				join(
					fields(current.bytes).map((field) =>
						field.number === 11 && editedIds.has(nodeId(decode(nodeType, field.data)))
							? messageField(11, editedNodes.get(nodeId(decode(nodeType, field.data)))!)
							: field.raw
					)
				)
			)
		}
		const bytes = latest.document.compile(replacements)
		new RoomDocument(bytes)
		return bytes
	}
	private entityBytes(): Uint8Array {
		return join(
			fields(this.document.bytes)
				.filter((f) => f.number === 28)
				.flatMap((f) =>
					fields(f.data)
						.filter((child) => child.number === 6)
						.map((child) => child.raw)
				)
		)
	}
	private rootMetadataBytes(): Uint8Array {
		return join(
			fields(this.document.bytes)
				.filter((field) => field.number === 28)
				.flatMap((field) =>
					fields(field.data)
						.filter((child) => child.number !== 2)
						.map((child) => child.raw)
				)
		)
	}
}
