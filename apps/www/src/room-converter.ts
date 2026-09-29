import { JULY_2025_ROOM_IMPORT_VERSIONS } from '@repo/domain/src/room-import-versions'

/**
 * Patch only the scene's protobuf version fields. Object and circuit payloads stay intact.
 * A version label alone cannot make newer content compatible with an older client.
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

function visitFields(
	data: Uint8Array,
	visit: (
		fieldNumber: number,
		wireType: number,
		valuePos: number,
		fieldEnd: number,
		payloadPos?: number
	) => void
): void {
	let pos = 0
	while (pos < data.length) {
		const [tag, valuePos] = readVarint(data, pos)
		const fieldNumber = Math.floor(tag / 8)
		const wireType = tag % 8
		if (fieldNumber === 0) throw new Error('Scene has an invalid protobuf field.')

		if (wireType === 0) {
			pos = skipVarint(data, valuePos)
			visit(fieldNumber, wireType, valuePos, pos)
		} else if (wireType === 1) {
			pos = checkedEnd(data, valuePos + 8)
			visit(fieldNumber, wireType, valuePos, pos)
		} else if (wireType === 2) {
			const [length, payloadPos] = readVarint(data, valuePos)
			pos = checkedEnd(data, payloadPos + length)
			visit(fieldNumber, wireType, valuePos, pos, payloadPos)
		} else if (wireType === 5) {
			pos = checkedEnd(data, valuePos + 4)
			visit(fieldNumber, wireType, valuePos, pos)
		} else {
			throw new Error('Scene has an unsupported protobuf wire type.')
		}
	}
}

/** Read the embedded scene version; a legacy scene may have no version field. */
export function roomVersion(data: Uint8Array): number | undefined {
	let version: number | undefined
	visitFields(data, (fieldNumber, wireType, valuePos) => {
		if (fieldNumber === 30 && wireType === 0) [version] = readVarint(data, valuePos)
	})
	return version
}

function joinParts(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
	let offset = 0
	for (const part of parts) {
		output.set(part, offset)
		offset += part.length
	}
	return output
}

/** Change only top-level varints of one field, retaining every other byte. */
function rewriteVarints(
	data: Uint8Array,
	field: number,
	replacement: (value: number) => number,
	required = false
): Uint8Array<ArrayBuffer> {
	const source = Uint8Array.from(data)
	const parts: Uint8Array[] = []
	let copiedThrough = 0
	let changed = false
	let found = false

	visitFields(source, (fieldNumber, wireType, valuePos, fieldEnd) => {
		if (fieldNumber !== field || wireType !== 0) return
		found = true
		const [value] = readVarint(source, valuePos)
		const target = replacement(value)
		if (value !== target) {
			parts.push(source.subarray(copiedThrough, valuePos), encodeVarint(target))
			copiedThrough = fieldEnd
			changed = true
		}
	})

	if (required && !found) throw new Error('Scene data has no persistence version (field 30).')
	if (!changed) return source

	parts.push(source.subarray(copiedThrough))
	return joinParts(parts)
}

/** Change only top-level field 30, retaining all other scene bytes. */
export function forceRoomVersion(data: Uint8Array, targetVersion: number): Uint8Array<ArrayBuffer> {
	return rewriteVarints(data, 30, () => targetVersion, true)
}

/** Cap the nested Circuits V2 serialization version without discarding circuit data. */
export function capRoomCircuitVersion(
	data: Uint8Array,
	maxVersion = JULY_2025_ROOM_IMPORT_VERSIONS.circuitsV2
): Uint8Array<ArrayBuffer> {
	const source = Uint8Array.from(data)
	const parts: Uint8Array[] = []
	let copiedThrough = 0
	visitFields(source, (fieldNumber, wireType, valuePos, fieldEnd, payloadPos) => {
		if (fieldNumber !== 28 || wireType !== 2 || payloadPos === undefined) return
		const payload = source.subarray(payloadPos, fieldEnd)
		let version: number | undefined
		visitFields(payload, (nestedField, nestedWireType, nestedValuePos) => {
			if (nestedField === 1 && nestedWireType === 0) {
				version = readVarint(payload, nestedValuePos)[0]
			}
		})
		if (version === undefined || version <= maxVersion) return
		const patched = rewriteVarints(payload, 1, (value) => Math.min(value, maxVersion))
		parts.push(source.subarray(copiedThrough, valuePos), encodeVarint(patched.length), patched)
		copiedThrough = fieldEnd
	})
	if (parts.length === 0) return source
	parts.push(source.subarray(copiedThrough))
	return joinParts(parts)
}

/** Change only top-level field 30 to version 1, retaining all other scene bytes. */
export function forceRoomVersionOne(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return forceRoomVersion(data, 1)
}
