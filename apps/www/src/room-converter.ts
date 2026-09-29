/**
 * Patch the top-level persistence version of an imported Rec Room scene.
 *
 * Scene files are protobuf messages. We walk only their top-level wire fields and copy
 * everything else as-is, including object data and circuits. A version label alone
 * cannot make content from a newer game build compatible with an older client.
 */

const TARGET_VERSION = 1

/** The file extension for scene data exported from a newer Rec Room build. */
export function isBinpbScene(filename: string): boolean {
	return filename.toLowerCase().endsWith('.binpb')
}

function readVarint(data: Uint8Array, start: number): [number, number] {
	let value = 0
	let scale = 1
	for (let pos = start; pos < Math.min(start + 10, data.length); pos++) {
		const byte = data[pos]
		value += (byte & 0x7f) * scale
		if (!Number.isSafeInteger(value)) throw new Error('Scene has an oversized protobuf value.')
		if ((byte & 0x80) === 0) return [value, pos + 1]
		scale *= 128
	}
	throw new Error('Scene has a truncated protobuf varint.')
}

function skipVarint(data: Uint8Array, start: number): number {
	for (let pos = start; pos < Math.min(start + 10, data.length); pos++) {
		if ((data[pos] & 0x80) === 0) return pos + 1
	}
	throw new Error('Scene has a truncated protobuf varint.')
}

function checkedEnd(data: Uint8Array, end: number): number {
	if (!Number.isSafeInteger(end) || end > data.length)
		throw new Error('Scene has a truncated protobuf field.')
	return end
}

/** Change only top-level field 30 to version 1, retaining all other scene bytes. */
export function forceRoomVersionOne(data: Uint8Array): Uint8Array<ArrayBuffer> {
	const source = Uint8Array.from(data)
	const parts: Uint8Array[] = []
	let pos = 0
	let copiedThrough = 0
	let foundVersion = false
	let changed = false

	while (pos < source.length) {
		const [tag, valuePos] = readVarint(source, pos)
		const fieldNumber = Math.floor(tag / 8)
		const wireType = tag % 8
		if (fieldNumber === 0) throw new Error('Scene has an invalid protobuf field.')

		if (wireType === 0) {
			const fieldEnd = skipVarint(source, valuePos)
			if (fieldNumber === 30) {
				const [version] = readVarint(source, valuePos)
				foundVersion = true
				if (version !== TARGET_VERSION) {
					parts.push(source.subarray(copiedThrough, valuePos), Uint8Array.of(TARGET_VERSION))
					copiedThrough = fieldEnd
					changed = true
				}
			}
			pos = fieldEnd
		} else if (wireType === 1) {
			pos = checkedEnd(source, valuePos + 8)
		} else if (wireType === 2) {
			const [length, payloadPos] = readVarint(source, valuePos)
			pos = checkedEnd(source, payloadPos + length)
		} else if (wireType === 5) {
			pos = checkedEnd(source, valuePos + 4)
		} else {
			throw new Error('Scene has an unsupported protobuf wire type.')
		}
	}

	if (!foundVersion) throw new Error('Scene data has no persistence version (field 30).')
	if (!changed) return source

	parts.push(source.subarray(copiedThrough))
	const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
	let offset = 0
	for (const part of parts) {
		output.set(part, offset)
		offset += part.length
	}
	return output
}
