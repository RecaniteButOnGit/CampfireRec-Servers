// Extract reusable metadata from checked-in room protobufs, never from the room
// being edited. Instance labels/defaults do not establish a built-in chip catalog.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const stable = (value) => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
			.join(',')}}`
	return JSON.stringify(value)
}

export function generateReferenceCatalog(root, schemaSha256) {
	const directory = new URL('../../cdn/static/room-templates/', import.meta.url)
	const sources = [
		{
			name: 'apps/discovery/static/escapees-base.room',
			url: new URL('../static/escapees-base.room', import.meta.url),
		},
		...readdirSync(directory)
			.filter((name) => name.endsWith('.room'))
			.sort()
			.map((name) => ({
				name: `apps/cdn/static/room-templates/${name}`,
				url: new URL(name, directory),
			})),
	]
	const chips = new Map(),
		nodeLayouts = new Map(),
		namedTypes = new Map(),
		events = new Map()
	const provenance = []
	const guid = (value) => {
		const bytes = Buffer.from(value?.value ?? '', 'base64')
		return bytes.length === 16 ? bytes.toString('hex') : null
	}
	for (const source of sources) {
		const bytes = readFileSync(source.url)
		const roomType = root.lookupType('rec_room.PersistedRoomData')
		const room = roomType.toObject(roomType.decode(bytes), {
			longs: String,
			bytes: String,
			enums: String,
		})
		const sourceId = source.name
		provenance.push({
			source: sourceId,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			roomVersion: room.version ?? null,
			circuitVersion: room.circuit_v2_data?.version ?? null,
		})
		const add = (map, record) => {
			const key = stable(record)
			const existing = map.get(key) ?? { ...record, sources: [] }
			if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId)
			map.set(key, existing)
		}
		function walk(type, data) {
			if (!data || typeof data !== 'object') return
			if (type.fullName === '.circuits_v2.CircuitNodeData') {
				const typeId = guid(data.node_type ?? { value: data.DEPRECATED_node_type })
				if (typeId) {
					const configuration = Object.fromEntries(
						Object.entries(data).filter(
							([key]) => type.fields[key]?.id >= 100 && !key.startsWith('DEPRECATED_')
						)
					)
					// Preserve observed arity, but do not promote instance constants to defaults.
					const inputGroups = (data.node_groups ?? []).map((group) => ({
						firstInputIndices: group.first_input_indices ?? [],
						inputCount: group.inputs?.length ?? 0,
					}))
					add(chips, { typeId, configuration, inputGroups })
					// Construction consumes only identity-free, typed, known storage fields.
					// Keep the full port layout here; a separate generator rejects scoped
					// bindings, deprecated layouts and opaque signal payloads.
					add(nodeLayouts, {
						typeId,
						configuration,
						nodeGroups: data.node_groups ?? [],
					})
				}
			}
			if (type.fullName === '.circuits.NamedTypeData' && data.name && data.type)
				add(namedTypes, { name: data.name, type: data.type })
			if (type.fullName === '.circuits_v2.EventDefinitionNodeData' && data.node_desc) {
				const eventId = guid(data.event_id ?? { value: data.DEPRECATED_event_id })
				if (eventId) add(events, { eventId, description: data.node_desc })
			}
			for (const field of type.fieldsArray) {
				if (!field.resolvedType?.fields || data[field.name] == null) continue
				const values = field.map
					? Object.values(data[field.name])
					: field.repeated
						? data[field.name]
						: [data[field.name]]
				for (const value of values) walk(field.resolvedType, value)
			}
		}
		walk(roomType, room)
	}
	const sorted = (map) =>
		[...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value)
	const catalog = {
		formatVersion: 1,
		schemaSha256,
		sources: provenance,
		chips: sorted(chips),
		namedTypes: sorted(namedTypes),
		events: sorted(events),
		nodeLayouts: sorted(nodeLayouts),
	}
	console.info(
		`Reference metadata: ${catalog.chips.length} chip variants, ${catalog.namedTypes.length} named types, ${catalog.events.length} events from ${sources.length} bundled rooms (${fileURLToPath(directory)})`
	)
	return catalog
}
