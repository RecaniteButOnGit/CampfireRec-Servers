import { createHash } from 'node:crypto'

const stable = (value) => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
			.join(',')}}`
	return JSON.stringify(value)
}

/** Canonical construction recipes, derived from exact GUID/descriptor/layout evidence. */
export function generateConstructionCatalog(published, references) {
	const chips = new Map(published.chips.map((chip) => [chip.typeId, chip]))
	const recipes = new Map()
	for (const observed of references.nodeLayouts) {
		const chip = chips.get(observed.typeId)
		if (!chip?.inPalette) continue
		const config = structuredClone(observed.configuration)
		const variable = Object.hasOwn(config, 'variable_node_data')
		// Dynamic chip names/ports need a configuration-specific adapter. Variables
		// have an authoritative fixed descriptor plus a fresh name/memory mode.
		if (chip.metadata.ChipNameSource === 'Code' && !variable) continue
		if (variable) config.variable_node_data = {}
		const containsBinding = (value) =>
			value &&
			typeof value === 'object' &&
			Object.entries(value).some(
				([name, child]) =>
					name === 'value' ||
					name.endsWith('_id') ||
					name.endsWith('_ids') ||
					name.startsWith('DEPRECATED_') ||
					containsBinding(child)
			)
		// No graph/object/event/resource IDs, old port IDs, or class descriptors
		// carrying source-only bindings enter a creation recipe.
		if (containsBinding(config)) continue
		// The export shows only the palette ports for these expandable outputs;
		// an input layout cannot establish their configured output ordering.
		if (config.sequence_node_data || config.switch_node_data) continue
		const groups = chip.metadata.NodeDescs
		if (groups.length !== observed.nodeGroups.length) continue
		let valid = true
		const nodeGroups = observed.nodeGroups.map((group, index) => {
			const indices = group.first_input_indices ?? [],
				inputs = group.inputs ?? []
			if (
				Object.keys(group).some((name) => name.startsWith('DEPRECATED_')) ||
				indices.length !== groups[index].Inputs.length ||
				(indices.length ? indices[0] !== 0 : inputs.length !== 0) ||
				indices.some(
					(start, i) => start < 0 || start >= inputs.length || (i && start <= indices[i - 1])
				)
			)
				valid = false
			return {
				first_input_indices: indices,
				inputs: inputs.map((input) => {
					const signal = input.default_signal_value ?? {}
					if (
						Object.keys(input).some((name) => name !== 'default_signal_value') ||
						Object.hasOwn(signal, 'backing_bytes')
					)
						valid = false
					// Zero-initialize only known scalar representations, preserving the
					// source layout's encoding. These are initial values, not a claim
					// about factory defaults. No room constants or references survive.
					const zero = Object.fromEntries(
						Object.entries(signal).map(([name, value]) => [
							name,
							name === 'DEPRECATED_type_kind'
								? value
								: typeof value === 'string'
									? ''
									: typeof value === 'boolean'
										? false
										: 0,
						])
					)
					return { default_signal_value: zero }
				}),
			}
		})
		if (!valid) continue
		const recipe = {
			typeId: observed.typeId,
			configuration: config,
			nodeGroups,
			variable,
			groups: groups.map((group) => ({
				name: group.Name,
				typeParameters: group.ReadonlyTypeParams,
				inputs: group.Inputs,
				outputs: group.Outputs,
			})),
		}
		const digest = createHash('sha256').update(stable(recipe)).digest('hex').slice(0, 16)
		const recipeId = `canonical:${observed.typeId}:${digest}`
		const existing = recipes.get(recipeId) ?? { id: recipeId, ...recipe, sources: [] }
		for (const source of observed.sources)
			if (!existing.sources.includes(source)) existing.sources.push(source)
		recipes.set(recipeId, existing)
	}
	return {
		formatVersion: 1,
		schemaSha256: references.schemaSha256,
		catalogSha256: published.source.sha256,
		recipes: [...recipes.values()].sort((a, b) => a.id.localeCompare(b.id)),
	}
}
