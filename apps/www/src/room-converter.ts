/**
 * Patch the top-level persistence version of an imported Rec Room scene.
 *
 * Scene files are protobuf messages. We walk only their top-level wire fields and copy
 * everything else as-is, including object data and circuits. A version label alone
 * cannot make content from a newer game build compatible with an older client.
 */

/** The file extension for scene data exported from a newer Rec Room build. */
export function isBinpbScene(filename: string): boolean {
	return filename.toLowerCase().endsWith('.binpb')
}

function encodeVarint(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error('Scene version must be a non-negative integer.')
	}
	const bytes: number[] = []
	do {
		const remainder = value % 128
		value = Math.floor(value / 128)
		bytes.push(remainder | (value > 0 ? 0x80 : 0))
	} while (value > 0)
	return Uint8Array.from(bytes)
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

function visitRoomVersions(
	data: Uint8Array,
	visit: (version: number, valuePos: number, fieldEnd: number) => void
): boolean {
	let pos = 0
	let foundVersion = false
	while (pos < data.length) {
		const [tag, valuePos] = readVarint(data, pos)
		const fieldNumber = Math.floor(tag / 8)
		const wireType = tag % 8
		if (fieldNumber === 0) throw new Error('Scene has an invalid protobuf field.')

		if (wireType === 0) {
			const fieldEnd = skipVarint(data, valuePos)
			if (fieldNumber === 30) {
				const [version] = readVarint(data, valuePos)
				visit(version, valuePos, fieldEnd)
				foundVersion = true
			}
			pos = fieldEnd
		} else if (wireType === 1) {
			pos = checkedEnd(data, valuePos + 8)
		} else if (wireType === 2) {
			const [length, payloadPos] = readVarint(data, valuePos)
			pos = checkedEnd(data, payloadPos + length)
		} else if (wireType === 5) {
			pos = checkedEnd(data, valuePos + 4)
		} else {
			throw new Error('Scene has an unsupported protobuf wire type.')
		}
	}
	return foundVersion
}

/** Read the embedded scene version; a legacy scene may have no version field. */
export function roomVersion(data: Uint8Array): number | undefined {
	let version: number | undefined
	visitRoomVersions(data, (value) => {
		version = value
	})
	return version
}

/** Change only top-level field 30, retaining all other scene bytes. */
export function forceRoomVersion(data: Uint8Array, targetVersion: number): Uint8Array<ArrayBuffer> {
	const source = Uint8Array.from(data)
	const parts: Uint8Array[] = []
	let copiedThrough = 0
	let changed = false

	const foundVersion = visitRoomVersions(source, (version, valuePos, fieldEnd) => {
		if (version !== targetVersion) {
			parts.push(source.subarray(copiedThrough, valuePos), encodeVarint(targetVersion))
			copiedThrough = fieldEnd
			changed = true
		}
	})

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

/** Change only top-level field 30 to version 1, retaining all other scene bytes. */
export function forceRoomVersionOne(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return forceRoomVersion(data, 1)
}
