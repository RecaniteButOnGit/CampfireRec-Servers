import protobuf from 'protobufjs/light.js'

import { CONSTRUCTION_PROVENANCE, Cv2ChipConstruction } from './construction'
import { nodeType, root, stable } from './protobuf'
import published from './published-catalog.json'
import references from './reference-catalog.json'

import type { Field } from 'protobufjs'
import type { RecordData } from './protobuf'

export type DefinitionCategory = 'chips' | 'types' | 'events' | 'variables' | 'metadata'
export type Cv2Definition = RecordData & {
	id: string
	name: string
	category: DefinitionCategory
	scope: 'global' | 'schema' | 'reference-save'
	completeness: { complete: boolean; missing: string[] }
	provenance: string[]
}

const catalog = published as RecordData
const samples = references as RecordData
const normalize = (value: string) =>
	value
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
const key = (value: string) => value.replace(/^\./, '').toLowerCase().trim()
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}
function fieldDefinition(field: Field) {
	return {
		name: field.name,
		fieldNumber: field.id,
		type: field.resolvedType?.fullName.replace(/^\./, '') ?? field.type,
		repeated: field.repeated,
		map: field.map,
		mapKeyType: field instanceof protobuf.MapField ? field.keyType : null,
		oneof: field.partOf?.name ?? null,
		deprecated: field.name.startsWith('DEPRECATED_') || field.options?.deprecated === true,
		explicitDefault: field.options?.default ?? null,
		// These are wire-format defaults, not application/chip configuration defaults.
		wireDefault: field.defaultValue instanceof Uint8Array ? [] : field.defaultValue,
		options: field.options ?? {},
	}
}
function descriptions(configuration: RecordData): RecordData[] {
	return Object.values(configuration).flatMap((value) => {
		if (!value || typeof value !== 'object') return []
		return value.node_desc ? [value.node_desc] : (value.node_descs ?? [])
	})
}
function observedPort(port: RecordData, order: number, direction: 'input' | 'output') {
	return {
		name: port.name ?? '',
		order,
		direction,
		execution: port.type?.kind === 'Exec',
		serializedType: port.type ?? null,
		defaultValue: port.default_value ?? null,
		defaultAmount: port.default_amount ?? null,
		minimum: port.minimum ?? null,
		maximum: port.maximum ?? null,
	}
}

/** Shared immutable knowledge; target-room instances never mutate this registry. */
export class Cv2DefinitionRegistry {
	private readonly definitions = new Map<string, Cv2Definition>()
	private readonly chips = new Map<string, Cv2Definition>()
	private readonly names = new Map<string, Set<string>>()
	private readonly searchable = new Map<string, string>()
	private readonly variants = new Map<string, RecordData[]>()
	readonly info: Readonly<RecordData>
	readonly construction = new Cv2ChipConstruction((name) => {
		const type = this.getType(name)
		return Boolean(
			type && type.scope === 'global' && !('genericExpression' in type && type.genericExpression)
		)
	})

	constructor() {
		if (
			CONSTRUCTION_PROVENANCE.schemaSha256 !== samples.schemaSha256 ||
			CONSTRUCTION_PROVENANCE.catalogSha256 !== catalog.source.sha256
		)
			throw new Error('Canonical CV2 catalog is stale; regenerate it with cv2-schema/generate.mjs')
		for (const sample of samples.chips) {
			const variants = this.variants.get(sample.typeId) ?? []
			variants.push(freeze(sample))
			this.variants.set(sample.typeId, variants)
		}
		const types = new Map<
			string,
			{ uses: Set<string>; generic: boolean; mappings: Map<string, RecordData> }
		>()
		const addType = (name: string, chip: string, generic: boolean) => {
			const type = types.get(name) ?? { uses: new Set(), generic, mappings: new Map() }
			type.uses.add(chip)
			type.generic ||= generic
			types.set(name, type)
		}
		for (const entry of catalog.chips) {
			const metadata = entry.metadata
			const groups = metadata.NodeDescs.map((desc: RecordData, group: number) => {
				const params = desc.ReadonlyTypeParams ?? {}
				const ports = (values: RecordData[], direction: 'input' | 'output') =>
					values.map((value, order) => {
						const generic = Object.keys(params).some((param) =>
							value.ReadonlyType.split(/[^a-zA-Z0-9_]+/).includes(param)
						)
						addType(value.ReadonlyType, entry.typeId, generic)
						return {
							name: value.Name,
							type: value.ReadonlyType,
							order,
							group,
							direction,
							execution: value.ReadonlyType === 'exec',
							generic,
							description: value.Description,
						}
					})
				return {
					name: desc.Name,
					group,
					typeParameters: params,
					inputs: ports(desc.Inputs, 'input'),
					outputs: ports(desc.Outputs, 'output'),
				}
			})
			const observations = this.variants.get(entry.typeId) ?? []
			// Bind a public type name to a serialized type only when the same chip's
			// entire concrete descriptor matches. Configured event ports are distinct.
			for (const observation of observations)
				for (const desc of descriptions(observation.configuration)) {
					const match = groups.find(
						(group: RecordData) =>
							group.name === desc.name &&
							['inputs', 'outputs'].every(
								(side) =>
									group[side].length === (desc[side]?.length ?? 0) &&
									group[side].every(
										(port: RecordData, index: number) =>
											!port.generic &&
											port.name === (desc[side][index].name ?? '') &&
											port.execution === (desc[side][index].type?.kind === 'Exec')
									)
							)
					)
					if (match)
						for (const side of ['inputs', 'outputs'])
							for (const [index, port] of match[side].entries()) {
								const serializedType = desc[side][index].type
								if (serializedType)
									types.get(port.type)!.mappings.set(stable(serializedType), {
										serializedType,
										chipTypeId: entry.typeId,
										provenance: observation.sources,
									})
							}
				}
			const configurationFields = [
				...new Set<string>(observations.flatMap((v) => Object.keys(v.configuration))),
			]
				.filter((name) => nodeType.fields[name])
				.map((name) => fieldDefinition(nodeType.fields[name]))
			const chip: Cv2Definition = {
				id: `chip:${entry.typeId}`,
				category: 'chips',
				scope: 'global',
				name: metadata.ReadonlyChipName,
				paletteName: metadata.ReadonlyPaletteName,
				typeId: entry.typeId,
				runtimeGuid: entry.runtimeGuid,
				description: metadata.Description,
				groups,
				inputs: groups.flatMap((group: RecordData) => group.inputs),
				outputs: groups.flatMap((group: RecordData) => group.outputs),
				execInputs: groups.flatMap((group: RecordData) =>
					group.inputs.filter((p: RecordData) => p.execution)
				),
				execOutputs: groups.flatMap((group: RecordData) =>
					group.outputs.filter((p: RecordData) => p.execution)
				),
				availability: {
					inPublishedPalette: entry.inPalette,
					beta: metadata.IsBetaChip,
					room1: metadata.IsValidInRoom1,
					room2: metadata.IsValidInRoom2,
					deprecationStage: metadata.DeprecationStage,
				},
				metadata,
				configurationFields,
				observedVariantCount: observations.length,
				instantiation: {
					supportedFromDefinitionAlone: this.construction.list(entry.typeId).length > 0,
					constructionIds: this.construction.list(entry.typeId).map((recipe) => recipe.id),
					requires: this.construction.list(entry.typeId).length
						? 'Use the canonical registry recipe; generic bindings need concrete wire evidence, variables need a fresh name. No target-room chip instance is needed.'
						: 'No verified canonical recipe is available for this chip; missing configuration/layout cannot be invented.',
				},
				completeness: {
					complete: false,
					missing: [
						'factoryDefaults',
						...(this.construction.list(entry.typeId).length
							? []
							: ['serializedInstantiationTemplate', 'configuredPortArity']),
						...(groups.some((group: RecordData) => Object.keys(group.typeParameters).length)
							? ['concreteGenericBindings']
							: []),
						...(!observations.length ? ['configurationPayloadMapping'] : []),
					],
				},
				provenance: [
					'official-catalog',
					...new Set<string>(observations.flatMap((v) => v.sources)),
				],
			}
			this.add(chip, [entry.runtimeGuid, entry.typeId, metadata.ReadonlyPaletteName])
			this.chips.set(entry.typeId, chip)
		}
		for (const named of samples.namedTypes) {
			addType(named.name, '', false)
			types.get(named.name)!.uses.delete('')
			types.get(named.name)!.mappings.set(stable(named.type), {
				serializedType: named.type,
				provenance: named.sources,
			})
		}
		for (const [name, type] of types) {
			const mappings = [...type.mappings.values()]
			this.add({
				id: `type:${name}`,
				name,
				category: 'types',
				scope: 'global',
				genericExpression: type.generic,
				usedBy: [...type.uses].sort(compare),
				serializedMappings: mappings,
				completeness: {
					complete: false,
					missing: mappings.length
						? ['runtimeSemantics']
						: ['serializedTypeIdentity', 'runtimeSemantics'],
				},
				provenance: ['official-catalog', ...new Set<string>(mappings.flatMap((v) => v.provenance))],
			})
		}
		// Unknown GUIDs observed in reference saves remain unnamed: room labels do
		// not establish global display names or runtime behavior.
		for (const [typeId, observations] of this.variants)
			if (!this.chips.has(typeId)) {
				const chip: Cv2Definition = {
					id: `chip:${typeId}`,
					name: `Unidentified chip ${typeId}`,
					typeId,
					category: 'chips',
					scope: 'reference-save',
					observedVariantCount: observations.length,
					completeness: {
						complete: false,
						missing: [
							'displayName',
							'globalPortDefinition',
							'runtimeSemantics',
							'serializedInstantiationTemplate',
						],
					},
					instantiation: { supportedFromDefinitionAlone: false },
					provenance: [...new Set<string>(observations.flatMap((v) => v.sources))],
				}
				this.add(chip, [typeId])
				this.chips.set(typeId, chip)
			}
		const walk = (namespace: protobuf.Namespace) => {
			for (const value of namespace.nestedArray) {
				if (value instanceof protobuf.Type || value instanceof protobuf.Enum) {
					const name = value.fullName.replace(/^\./, '')
					if (/^circuits(?:_v2)?\./.test(name) || name === 'core.GuidData') {
						const category: DefinitionCategory = /Event|Rpc/.test(value.name)
							? 'events'
							: /Variable|MemoryType/.test(value.name)
								? 'variables'
								: /Type|Desc/.test(value.name)
									? 'types'
									: 'metadata'
						this.add({
							id: `schema:${name}`,
							name,
							category,
							scope: 'schema',
							schema: value.toJSON(),
							...(value instanceof protobuf.Type
								? { fields: value.fieldsArray.map(fieldDefinition) }
								: { enumValues: value.values }),
							completeness: { complete: false, missing: ['runtimeSemantics'] },
							provenance: ['protobuf-schema'],
						})
					}
				}
				if (value instanceof protobuf.Namespace) walk(value)
			}
		}
		walk(root)
		for (const event of samples.events) {
			const desc = event.description
			// Names/IDs from bundled saves are scoped examples, never global built-in events.
			this.add(
				{
					id: `event:${event.eventId}:${event.sources.join('|')}`,
					name: desc.name ?? event.eventId,
					category: 'events',
					scope: 'reference-save',
					eventId: event.eventId,
					inputs: (desc.inputs ?? []).map((p: RecordData, i: number) =>
						observedPort(p, i, 'input')
					),
					outputs: (desc.outputs ?? []).map((p: RecordData, i: number) =>
						observedPort(p, i, 'output')
					),
					description: desc,
					completeness: { complete: false, missing: ['targetRoomEventBinding'] },
					provenance: event.sources,
				},
				[event.eventId]
			)
		}
		for (const chip of this.chips.values()) {
			if (
				chip.metadata?.NodeFilters?.some(
					(filter: RecordData) => filter.FilterPath[0] === 'Variable'
				)
			)
				this.add({
					id: `variable:${chip.typeId}`,
					name: chip.name,
					category: 'variables',
					scope: 'global',
					chipId: chip.id,
					typeId: chip.typeId,
					behavior: chip.description,
					completeness: { complete: false, missing: ['targetRoomVariableBinding'] },
					provenance: chip.provenance,
				})
		}
		this.info = freeze({
			formatVersion: 1,
			counts: Object.fromEntries(
				['chips', 'types', 'events', 'variables', 'metadata'].map((category) => [
					category,
					[...this.definitions.values()].filter((v) => v.category === category).length,
				])
			),
			publishedChipCount: catalog.chips.length,
			paletteChipCount: catalog.chips.filter((v: RecordData) => v.inPalette).length,
			constructibleChipCount: catalog.chips.filter(
				(v: RecordData) => this.construction.list(v.typeId).length
			).length,
			provenance: {
				officialCatalog: catalog.source,
				protobufSha256: samples.schemaSha256,
				referenceSaves: samples.sources,
			},
			limitations: [
				'Pinned catalog availability describes its export version, not a guarantee for this room/client version.',
				'Full catalog includes hidden/development chips; check availability.inPublishedPalette.',
				'Catalog descriptor order does not determine expanded/variadic wire indices.',
				'Reference-save configurations/events/types are observations, not universal defaults or target-room bindings.',
				'Canonical recipes construct supported chips with fresh IDs and verified port layouts independently of target-room instances. Unsupported layouts/bindings and entity topology remain rejected.',
			],
		})
	}

	private add(value: Cv2Definition, aliases: string[] = []) {
		if (this.definitions.has(value.id)) throw new Error(`Duplicate CV2 definition ${value.id}`)
		freeze(value)
		this.definitions.set(value.id, value)
		this.searchable.set(value.id, normalize(stable(value)))
		for (const name of [value.id, value.name, ...aliases]) {
			const matches = this.names.get(key(name)) ?? new Set<string>()
			matches.add(value.id)
			this.names.set(key(name), matches)
		}
	}
	private lookup(name: string, category?: DefinitionCategory) {
		const matches = [...(this.names.get(key(name)) ?? [])]
			.map((id) => this.definitions.get(id)!)
			.filter((value) => !category || value.category === category)
		if (matches.length > 1)
			throw new Error(
				`Ambiguous definition ${name}; use one of: ${matches.map((v) => v.id).join(', ')}`
			)
		return matches[0] ?? null
	}
	getChip(idOrName: string) {
		return this.lookup(idOrName, 'chips')
	}
	getType(name: string) {
		const known = this.lookup(name, 'types') ?? this.lookup(`schema:${name.replace(/^\./, '')}`)
		if (known) return known
		const schema = root.lookup(name)
		return schema instanceof protobuf.Type || schema instanceof protobuf.Enum
			? freeze({
					id: `schema:${schema.fullName.slice(1)}`,
					name: schema.fullName.slice(1),
					category: 'types',
					scope: 'schema',
					schema: schema.toJSON(),
					completeness: { complete: false, missing: ['runtimeSemantics'] },
					provenance: ['protobuf-schema'],
				})
			: null
	}
	getEvent(name: string) {
		return this.lookup(name, 'events')
	}
	getDefinition(name: string) {
		return this.definitions.get(name) ?? this.lookup(name)
	}
	getChipVariants(idOrName: string, offset = 0, limit = 5) {
		const chip = this.getChip(idOrName)
		if (!chip) throw new Error(`Unknown CV2 chip ${idOrName}`)
		this.page(offset, limit)
		const variants = this.variants.get(chip.typeId) ?? []
		return {
			typeId: chip.typeId,
			total: variants.length,
			offset,
			variants: variants.slice(offset, offset + limit),
			note: 'Observed source-save configurations and arity only. Not defaults or templates for instantiation; event/object/variable references are source-save scoped.',
		}
	}
	searchChips(query: string, offset = 0, limit = 20) {
		return this.searchDefinitions(query, 'chips', offset, limit)
	}
	searchTypes(query: string, offset = 0, limit = 20) {
		return this.searchDefinitions(query, 'types', offset, limit)
	}
	private page(offset: number, limit: number) {
		if (
			!Number.isInteger(offset) ||
			offset < 0 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 50
		)
			throw new Error('Registry pagination requires offset >= 0 and limit 1–50')
	}
	searchDefinitions(
		query: string,
		category: DefinitionCategory | 'all' = 'all',
		offset = 0,
		limit = 20
	) {
		this.page(offset, limit)
		if (!query.trim() || query.length > 200)
			throw new Error('Registry query must contain 1–200 characters; use * to list definitions')
		const tokens = query === '*' ? [] : normalize(query).split(' ').filter(Boolean)
		if (query !== '*' && !tokens.length) throw new Error('Registry query needs a word or *')
		const matches = [...this.definitions.values()]
			.filter(
				(value) =>
					(category === 'all' || value.category === category) &&
					tokens.every((token) => this.searchable.get(value.id)!.includes(token))
			)
			.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
		return {
			total: matches.length,
			offset,
			nextOffset: offset + limit < matches.length ? offset + limit : null,
			definitions: matches.slice(offset, offset + limit).map((value) => ({
				id: value.id,
				name: value.name,
				category: value.category,
				scope: value.scope,
				typeId: value.typeId ?? null,
				description: typeof value.description === 'string' ? value.description.slice(0, 500) : null,
				availability: value.availability ?? null,
				completeness: value.completeness,
			})),
		}
	}
}

let cached: Cv2DefinitionRegistry | undefined
/** Built once per process/Worker isolate; deployment changes invalidate the cache. */
export function getCv2DefinitionRegistry(): Cv2DefinitionRegistry {
	return (cached ??= new Cv2DefinitionRegistry())
}
