// Normalize the pinned official export. Never download metadata during an agent run.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function generatePublishedCatalog() {
	const read = (name) => readFileSync(new URL(`./upstream/${name}`, import.meta.url))
	const source = JSON.parse(read('source.json'))
	const full = read('circuitsv2.full.json'),
		palette = read('circuitsv2.json')
	const nodes = JSON.parse(full).Nodes,
		publicNodes = JSON.parse(palette).Nodes
	if (Object.keys(publicNodes).some((key) => !nodes[key]))
		throw new Error('Official palette contains a chip absent from the full catalog')
	return {
		formatVersion: 1,
		source: {
			...source,
			sha256: createHash('sha256').update(full).digest('hex'),
			paletteSha256: createHash('sha256').update(palette).digest('hex'),
		},
		chips: Object.entries(nodes)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([runtimeGuid, metadata]) => ({
				runtimeGuid,
				// Guid.ToByteArray stores the first three GUID components little endian.
				typeId: runtimeGuid
					.split('-')
					.map((part, index) => (index < 3 ? part.match(/../g).reverse().join('') : part))
					.join(''),
				inPalette: Object.hasOwn(publicNodes, runtimeGuid),
				metadata,
			})),
	}
}
