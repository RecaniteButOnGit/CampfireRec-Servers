import catalog from './construction-catalog.json'
import { checkRecord, guid, id, nodeType, stable } from './protobuf'

import type { RecordData } from './protobuf'

export type ConstructionOptions = {
	recipe?: string
	bindings?: Record<string, string>
	variable?: { name: string; memory_type?: string }
}
export type ConstructionRecipe = RecordData & {
	id: string
	typeId: string
	nodeGroups: RecordData[]
	groups: RecordData[]
	variable: boolean
	sources: string[]
}

const recipes = (catalog as RecordData).recipes as ConstructionRecipe[]
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
freeze(recipes)
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

/** Canonical recipes contain no source node IDs, geometry or scoped bindings. */
export class Cv2ChipConstruction {
	private readonly byType = new Map<string, ConstructionRecipe[]>()
	constructor(private readonly isConcreteType: (name: string) => boolean) {
		for (const recipe of recipes) {
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
	}
	list(typeId: string) {
		return this.byType.get(typeId) ?? []
	}
	get(typeId: string, recipeId?: string): ConstructionRecipe {
		const known = this.list(typeId)
		const recipe = recipeId ? known.find((value) => value.id === recipeId) : known[0]
		if (!recipe)
			throw new Error(
				recipeId
					? `Unknown construction recipe ${recipeId} for chip ${typeId}`
					: `Chip ${typeId} has no verified canonical construction recipe; missing layout/configuration data cannot be invented`
			)
		return recipe
	}
	bindings(recipe: ConstructionRecipe, bindings: Record<string, string> = {}) {
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
		const recipe = this.get(typeId, options.recipe)
		this.bindings(recipe, options.bindings)
		const data: RecordData = {
			...structuredClone(recipe.configuration),
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
		return { recipe, data }
	}
	match(node: RecordData): ConstructionRecipe | null {
		let typeId: string
		try {
			typeId = id(node.node_type)
		} catch {
			return null
		}
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
