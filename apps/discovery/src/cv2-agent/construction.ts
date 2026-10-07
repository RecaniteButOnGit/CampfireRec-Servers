import catalog from './construction-catalog.json'
import { checkRecord, guid, id, nodeType, stable } from './protobuf'
import published from './published-catalog.json'
import references from './reference-catalog.json'

import type { RecordData } from './protobuf'

export type ConstructionOptions = {
	bindings?: Record<string, string>
	variable?: { name: string; memory_type?: string }
	configuration?: RecordData
}
export type ConstructionDefinition = RecordData & {
	id: string
	typeId: string
	nodeGroups: RecordData[]
	groups: RecordData[]
	variable: boolean
	sources: string[]
}

const layouts = (catalog as RecordData).layouts as ConstructionDefinition[]
export const CONSTRUCTION_PROVENANCE = Object.freeze({
	schemaSha256: catalog.schemaSha256,
	catalogSha256: catalog.catalogSha256,
})
function freeze(value: unknown): void {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
}
freeze(layouts)
const primitiveKinds: Record<string, string> = {
	any: 'Any',
	bool: 'Boolean',
	int: 'Int32',
	float: 'Single',
	string: 'String',
	exec: 'Exec',
}
export function semanticType(name: string): RecordData {
	return primitiveKinds[name] ? { kind: primitiveKinds[name] } : { kind: 'Registry', name }
}
export function replaceParameters(type: string, bindings: Record<string, string>): string {
	return type.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => bindings[name] ?? name)
}
const layout = (groups: RecordData[]) =>
	groups.map((group) => ({
		indices: group.first_input_indices ?? [],
		count: group.inputs?.length ?? 0,
	}))
const payloads = (data: RecordData) =>
	Object.keys(data)
		.filter((name) => nodeType.fields[name]?.id >= 100 && name !== 'color_data')
		.sort()

/** Builds known chip GUIDs from public descriptors. Observations only enrich layouts. */
export class Cv2ChipFactory {
	private readonly byType = new Map<string, ConstructionDefinition[]>()
	private readonly definitions = new Map<string, ConstructionDefinition>()
	constructor(private readonly isConcreteType: (name: string) => boolean) {
		for (const recipe of layouts) {
			const list = this.byType.get(recipe.typeId) ?? []
			list.push(recipe)
			this.byType.set(recipe.typeId, list)
		}
		for (const list of this.byType.values())
			list.sort(
				(a, b) =>
					a.nodeGroups.reduce((n, g) => n + (g.inputs?.length ?? 0), 0) -
						b.nodeGroups.reduce((n, g) => n + (g.inputs?.length ?? 0), 0) ||
					(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
			)
		for (const list of this.byType.values()) Object.freeze(list)
		for (const chip of (published as RecordData).chips) {
			if (!chip.inPalette) continue
			const observed = this.list(chip.typeId)[0]
			const groups = chip.metadata.NodeDescs.map((group: RecordData) => ({
				name: group.Name,
				typeParameters: group.ReadonlyTypeParams,
				inputs: group.Inputs,
				outputs: group.Outputs,
			}))
			const observations = (references as RecordData).chips.filter(
				(value: RecordData) => value.typeId === chip.typeId
			)
			const configurationFields = [
				...new Set<string>(
					observations.flatMap((value: RecordData) => Object.keys(value.configuration))
				),
			].filter((name) => nodeType.fields[name]?.id >= 100 && !name.startsWith('DEPRECATED_'))
			const configuration: RecordData = {}
			const requiredBindings: string[] = []
			const requiredMetadata: string[] = []
			for (const name of configurationFields) {
				const field = nodeType.fields[name]!
				if (field.resolvedType && 'fields' in field.resolvedType) {
					// An empty message uses protobuf wire defaults. Never copy a room's
					// values, GUIDs, resource bindings or configured event descriptors.
					configuration[name] = {}
					for (const descriptor of ['node_desc', 'node_descs'])
						if (
							field.resolvedType.fields[descriptor] &&
							observations.every((value: RecordData) => value.configuration[name]?.[descriptor])
						)
							requiredMetadata.push(`${name}.${descriptor}`)
					if (field.resolvedType.fields.output_count)
						configuration[name].output_count = groups.reduce(
							(count: number, group: RecordData) => count + group.outputs.length,
							0
						)
					for (const child of Object.values(field.resolvedType.fields))
						if (
							!child.name.startsWith('DEPRECATED_') &&
							child.resolvedType?.fullName === '.core.GuidData' &&
							observations.every(
								(value: RecordData) => value.configuration[name]?.[child.name]?.value
							)
						)
							requiredBindings.push(`${name}.${child.name}`)
				} else if (!field.repeated) configuration[name] = field.defaultValue
			}
			const definition: ConstructionDefinition = {
				id: `chip:${chip.typeId}`,
				typeId: chip.typeId,
				groups,
				nodeGroups: observed
					? observed.nodeGroups.map((group) => ({
							first_input_indices: [...group.first_input_indices],
							inputs: group.inputs.map(() => ({ default_signal_value: {} })),
						}))
					: groups.map((group: RecordData) => ({
							first_input_indices: group.inputs.map((_: unknown, index: number) => index),
							inputs: group.inputs.map(() => ({ default_signal_value: {} })),
						})),
				configuration,
				configurationFields,
				requiredBindings,
				requiredMetadata,
				variable: configurationFields.includes('variable_node_data'),
				layoutSource: observed ? 'observed-expansion' : 'published-descriptor',
				initialization: 'Protobuf wire defaults; not undocumented client factory defaults.',
				sources: ['official-catalog', ...(observed?.sources ?? [])],
			}
			freeze(definition)
			this.definitions.set(chip.typeId, definition)
		}
	}
	list(typeId: string) {
		return this.byType.get(typeId) ?? []
	}
	supports(typeId: string) {
		return this.definitions.has(typeId)
	}
	get(typeId: string): ConstructionDefinition {
		const definition = this.definitions.get(typeId)
		if (!definition) throw new Error(`Unknown or unavailable published CV2 chip ${typeId}`)
		return definition
	}
	bindings(recipe: ConstructionDefinition, bindings: Record<string, string> = {}) {
		const parameters = recipe.groups.flatMap((group) =>
			Object.entries(group.typeParameters).map(([name, constraint]) => ({
				name,
				constraint: String(constraint),
				group,
			}))
		)
		const used = parameters.filter(({ name, group }) =>
			[...group.inputs, ...group.outputs].some((port) =>
				port.ReadonlyType.split(/[^A-Za-z0-9_]+/).includes(name)
			)
		)
		if (Object.keys(bindings).some((name) => !used.some((parameter) => parameter.name === name)))
			throw new Error('Unknown or unused generic type parameter')
		for (const { name, constraint } of used) {
			const type = bindings[name]
			if (!type || !this.isConcreteType(type) || type === 'exec' || type === 'any')
				throw new Error(`Generic parameter ${name} requires a known concrete data type`)
			if (constraint !== 'any') {
				const allowed = this.isConcreteType(constraint)
					? [constraint]
					: /^\(([^()]+)\)$/
							.exec(constraint)?.[1]
							?.split('|')
							.map((value) => value.trim())
				if (!allowed || !allowed.includes(type))
					throw new Error(`Generic parameter ${name}: ${type} does not satisfy ${constraint}`)
			}
		}
		return bindings
	}
	construct(typeId: string, nodeId: string, options: ConstructionOptions = {}) {
		const recipe = this.get(typeId)
		this.bindings(recipe, options.bindings)
		if (
			options.configuration !== undefined &&
			(!options.configuration ||
				typeof options.configuration !== 'object' ||
				Array.isArray(options.configuration))
		)
			throw new Error('Chip configuration must be a JSON object')
		const configuration = structuredClone(recipe.configuration)
		for (const [name, value] of Object.entries(options.configuration ?? {})) {
			if (!recipe.configurationFields.includes(name))
				throw new Error(
					`${name}: no authoritative configuration payload mapping for chip ${typeId}`
				)
			configuration[name] = structuredClone(value)
		}
		for (const required of recipe.requiredBindings) {
			const [field, name] = required.split('.')
			if (!configuration[field!]?.[name!])
				throw new Error(`${required}: explicit valid scoped binding required`)
			if (id(configuration[field!][name!]) === '0'.repeat(32))
				throw new Error(`${required}: binding cannot be empty`)
		}
		for (const required of recipe.requiredMetadata) {
			const [field, name] = required.split('.')
			const value = configuration[field!]?.[name!]
			if (!value || (Array.isArray(value) ? !value.length : !Object.keys(value).length))
				throw new Error(`${required}: authoritative configured port metadata required`)
		}
		const data: RecordData = {
			...configuration,
			node_id: guid(nodeId),
			node_type: guid(typeId),
			node_groups: structuredClone(recipe.nodeGroups),
			transform_data: { local_position: {}, local_rotation: { w: 1 } },
		}
		if (recipe.variable) {
			const variable = options.variable
			if (!variable?.name?.trim() || variable.name.length > 200)
				throw new Error('New variables require an explicit nonempty name (maximum 200 characters)')
			const memory = variable.memory_type ?? 'Instance'
			if (!['Instance', 'Sync', 'Cloud'].includes(memory))
				throw new Error('Unsupported variable memory type')
			data.variable_node_data = { name: variable.name, memory_type: memory }
		} else if (options.variable)
			throw new Error('Variable configuration is only valid for variable chips')
		checkRecord(nodeType, data)
		return { definition: recipe, data }
	}
	match(node: RecordData): ConstructionDefinition | null {
		let typeId: string
		try {
			typeId = id(node.node_type)
		} catch {
			return null
		}
		const definition = this.definitions.get(typeId)
		if (!definition) return null
		if (stable(layout(definition.nodeGroups)) === stable(layout(node.node_groups ?? [])))
			return definition
		return (
			this.list(typeId).find(
				(recipe) =>
					stable(layout(recipe.nodeGroups)) === stable(layout(node.node_groups ?? [])) &&
					stable(payloads(recipe.configuration)) === stable(payloads(node))
			) ?? null
		)
	}
	port(
		node: RecordData,
		direction: 'inputs' | 'outputs',
		group: number,
		index: number,
		bindings: Record<string, string> = {}
	) {
		const recipe = this.match(node)
		if (!recipe) return null
		const desc = recipe.groups[group]
		if (!desc) throw new Error(`Port group ${group} does not exist`)
		if (direction === 'outputs') {
			for (const name of recipe.configurationFields ?? []) {
				const count = node[name]?.output_count
				if (count !== undefined && (count !== desc.outputs.length || index >= count))
					throw new Error(
						'Configured output count differs from the published descriptor; unknown port expansion cannot be invented'
					)
			}
		}
		let order = index
		if (direction === 'inputs') {
			const ports = recipe.nodeGroups[group]
			if (index >= (ports.inputs?.length ?? 0))
				throw new Error(`Input port ${group}.${index} does not exist`)
			order = ports.first_input_indices.findLastIndex((start: number) => start <= index)
		}
		const value = desc[direction][order]
		if (!value) throw new Error(`${direction} port ${group}.${index} does not exist`)
		const parameterNames = Object.keys(desc.typeParameters).filter((name) =>
			value.ReadonlyType.split(/[^A-Za-z0-9_]+/).includes(name)
		)
		if (parameterNames.some((name) => !bindings[name])) return null
		return {
			type: semanticType(replaceParameters(value.ReadonlyType, bindings)),
			parameters: parameterNames,
			recipe,
		}
	}
}
