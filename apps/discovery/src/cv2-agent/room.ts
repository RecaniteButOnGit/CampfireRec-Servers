import { decode, fields, graphType, id, join, messageField, roomType } from './protobuf'

import type { Type } from 'protobufjs'
import type { RecordData } from './protobuf'

type Tree = { type: Type; bytes: Uint8Array; children: Map<number, Tree[]> }
export type SavedGraph = { id: string; bytes: Uint8Array; data: RecordData }

/** Only walk branches which can contain a CV2 graph. Geometry stays opaque. */
const graphContainers = new Set<Type>([graphType])
function collectTypes(namespace: any): Type[] {
	return Object.values(namespace.nested ?? {}).flatMap((value: any) =>
		value.fieldsArray ? [value, ...collectTypes(value)] : collectTypes(value)
	)
}
const allTypes = collectTypes(roomType.root)
for (let changed = true; changed;) {
	changed = false
	for (const type of allTypes)
		if (
			!graphContainers.has(type) &&
			type.fieldsArray.some((f) => graphContainers.has(f.resolvedType as Type))
		) {
			graphContainers.add(type)
			changed = true
		}
}

export class RoomDocument {
	readonly graphs = new Map<string, SavedGraph>()
	readonly tree: Tree
	readonly hasEntities: boolean
	readonly objectIds = new Set<string>()
	constructor(readonly bytes: Uint8Array) {
		if (!bytes.length || bytes.length > 32 * 1024 * 1024)
			throw new Error('Room save is empty or exceeds 32 MiB')
		this.hasEntities = Boolean(decode(roomType, bytes).circuit_v2_data?.entities)
		const walk = (type: Type, raw: Uint8Array, depth: number): Tree => {
			if (depth > 64) throw new Error('Room protobuf nesting exceeds 64 levels')
			const tree: Tree = { type, bytes: raw, children: new Map() }
			if (type === graphType) {
				const data = decode(type, raw)
				const graphId = data.graph_id ? id(data.graph_id) : id({ value: data.DEPRECATED_graph_id })
				if (this.graphs.has(graphId)) throw new Error(`Duplicate graph ID ${graphId}`)
				this.graphs.set(graphId, { id: graphId, data, bytes: raw })
			}
			if (type.fullName === '.rec_room.PersistenceViewData') {
				const view = decode(type, raw)
				if (view.id) this.objectIds.add(id({ value: view.id }))
			}
			for (const field of fields(raw)) {
				const descriptor = type.fieldsById[field.number]
				if (descriptor && graphContainers.has(descriptor.resolvedType as Type)) {
					if (field.wire !== 2) throw new Error('CV2 message has an invalid protobuf wire type')
					const child = walk(descriptor.resolvedType as Type, field.data, depth + 1)
					const children = tree.children.get(field.number) ?? []
					children.push(child)
					tree.children.set(field.number, children)
				}
			}
			return tree
		}
		this.tree = walk(roomType, bytes, 0)
	}

	/** Replace CV2 graph slices and their length prefixes; preserve every other byte. */
	compile(replacements: Map<string, Uint8Array>): Uint8Array {
		const build = (tree: Tree): Uint8Array => {
			const graphId = tree.type === graphType ? idFromGraph(decode(graphType, tree.bytes)) : null
			const base = graphId ? (replacements.get(graphId) ?? tree.bytes) : tree.bytes
			const index = new Map<number, number>()
			return join(
				fields(base).map((field) => {
					const i = index.get(field.number) ?? 0
					index.set(field.number, i + 1)
					const child = tree.children.get(field.number)?.[i]
					if (!child) return field.raw
					const next = build(child)
					return equalBytes(next, field.data) ? field.raw : messageField(field.number, next)
				})
			)
		}
		return build(this.tree)
	}
}

export function idFromGraph(data: RecordData): string {
	return id(data.graph_id ?? { value: data.DEPRECATED_graph_id })
}
export function nodeId(data: RecordData): string {
	return id(data.node_id ?? { value: data.DEPRECATED_node_id })
}
export function nodeTypeId(data: RecordData): string {
	return id(data.node_type ?? { value: data.DEPRECATED_node_type })
}
export function sourceId(data: RecordData): string {
	return id(data.src_node_id ?? { value: data.DEPRECATED_src_node_id })
}
export function targetId(data: RecordData): string {
	return id(data.dst_node_id ?? { value: data.DEPRECATED_dst_node_id })
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i])
}
