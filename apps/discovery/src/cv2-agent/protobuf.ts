import protobuf from 'protobufjs/light.js'

import { root } from './generated-codecs'

import type { Field, Type } from 'protobufjs'

export type RecordData = Record<string, any>
export { root }
export const roomType = root.lookupType('rec_room.PersistedRoomData')
export const graphType = root.lookupType('circuits_v2.CircuitGraphData')
export const nodeType = root.lookupType('circuits_v2.CircuitNodeData')
export const edgeType = root.lookupType('circuits.StaticEdgeData')

export function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`)
			.join(',')}}`
	return JSON.stringify(value)
}

export function decode(type: Type, bytes: Uint8Array): RecordData {
	return type.toObject(type.decode(bytes), { longs: String, bytes: String, enums: String })
}

/** IDs are the exact 16 bytes on disk, with no GUID endianness conversion. */
export function id(value: RecordData | undefined): string {
	const bytes = typeof value?.value === 'string' ? atob(value.value) : ''
	if (bytes.length !== 16) throw new Error('Expected a 128-bit serialized GUID')
	return Array.from(bytes, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}
export function guid(value: string): RecordData {
	if (!/^[a-f0-9]{32}$/.test(value)) throw new Error(`Invalid GUID: ${value}`)
	return {
		value: btoa(
			value
				.match(/../g)!
				.map((pair) => String.fromCharCode(parseInt(pair, 16)))
				.join('')
		),
	}
}

export type WireField = { number: number; wire: number; raw: Uint8Array; data: Uint8Array }
export function join(parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
	let offset = 0
	for (const part of parts) {
		result.set(part, offset)
		offset += part.length
	}
	return result
}
function varint(n: number): Uint8Array {
	const parts: number[] = []
	do {
		const byte = n % 128
		n = Math.floor(n / 128)
		parts.push(byte | (n ? 128 : 0))
	} while (n)
	return Uint8Array.from(parts)
}
export function messageField(number: number, data: Uint8Array): Uint8Array {
	return join([varint(number * 8 + 2), varint(data.length), data])
}

/** Keep each original wire slice, including unknown fields and noncanonical ordering. */
export function fields(bytes: Uint8Array): WireField[] {
	const result: WireField[] = []
	let offset = 0
	function read(): bigint {
		let n = 0n
		for (let i = 0; i < 10; i++) {
			if (offset >= bytes.length) throw new Error('Truncated protobuf varint')
			const byte = bytes[offset++]!
			if (i === 9 && byte > 1) throw new Error('Overflowing protobuf varint')
			n |= BigInt(byte & 127) << BigInt(7 * i)
			if (!(byte & 128)) return n
		}
		throw new Error('Invalid protobuf varint')
	}
	while (offset < bytes.length) {
		const start = offset
		const tag = Number(read())
		const number = Math.floor(tag / 8),
			wire = tag % 8
		if (!number || number > 536870911) throw new Error('Invalid protobuf field number')
		let dataStart = offset
		if (wire === 0) read()
		else if (wire === 1) offset += 8
		else if (wire === 5) offset += 4
		else if (wire === 2) {
			const length = Number(read())
			dataStart = offset
			offset += length
		} else throw new Error(`Unsupported protobuf wire type ${wire}`)
		if (!Number.isSafeInteger(offset) || offset > bytes.length)
			throw new Error('Truncated protobuf field')
		result.push({
			number,
			wire,
			raw: bytes.slice(start, offset),
			data: bytes.slice(dataStart, offset),
		})
	}
	return result
}

export function checkRecord(type: Type, data: RecordData, path = type.fullName, depth = 0): void {
	if (depth > 80 || !data || typeof data !== 'object' || Array.isArray(data))
		throw new Error(`${path}: expected message object`)
	for (const [name, value] of Object.entries(data)) {
		const field = type.fields[name]
		if (!field) throw new Error(`${path}.${name}: nonexistent protobuf field`)
		const values = field.map ? Object.values(value) : field.repeated ? value : [value]
		if (!Array.isArray(values)) throw new Error(`${path}.${name}: expected array`)
		for (const item of values) {
			if (field.resolvedType instanceof protobuf.Type)
				checkRecord(field.resolvedType, item, `${path}.${name}`, depth + 1)
			else if (field.type === 'bytes') {
				if (
					typeof item !== 'string' ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item)
				)
					throw new Error(`${path}.${name}: expected base64 bytes`)
			} else if (field.resolvedType instanceof protobuf.Enum) {
				if (typeof item !== 'string' || !Object.hasOwn(field.resolvedType.values, item))
					throw new Error(`${path}.${name}: unknown enum value`)
			} else if (field.type === 'string' || field.type === 'bool') {
				if (typeof item !== (field.type === 'bool' ? 'boolean' : 'string'))
					throw new Error(`${path}.${name}: expected ${field.type}`)
			} else if (field.type.endsWith('64')) {
				if (typeof item !== 'string' || !/^-?\d+$/.test(item))
					throw new Error(`${path}.${name}: expected decimal 64-bit integer string`)
				const n = BigInt(item),
					unsigned = /^(?:u|fixed)/.test(field.type)
				if (n < (unsigned ? 0n : -(1n << 63n)) || n >= 1n << (unsigned ? 64n : 63n))
					throw new Error(`${path}.${name}: integer out of range`)
			} else {
				if (typeof item !== 'number' || !Number.isFinite(item))
					throw new Error(`${path}.${name}: expected finite ${field.type}`)
				if (!['float', 'double'].includes(field.type)) {
					const unsigned = /^(?:u|fixed)/.test(field.type)
					if (
						!Number.isInteger(item) ||
						item < (unsigned ? 0 : -2147483648) ||
						item > (unsigned ? 4294967295 : 2147483647)
					)
						throw new Error(`${path}.${name}: integer out of range`)
				}
			}
		}
	}
	for (const oneof of type.oneofsArray)
		if (oneof.oneof.filter((name) => Object.hasOwn(data, name)).length > 1)
			throw new Error(`${path}: multiple ${oneof.name} values`)
	const converted = type.fromObject(data)
	const error = type.verify(converted)
	if (error) throw new Error(`${path}: ${error}`)
}

function encodeField(type: Type, field: Field, value: unknown): Uint8Array {
	return type.encode(type.fromObject({ [field.name]: value })).finish()
}

/** Change only requested fields. Recursively preserve opaque data in nested messages. */
export function update(type: Type, bytes: Uint8Array, next: RecordData): Uint8Array {
	checkRecord(type, next)
	const before = decode(type, bytes)
	if (stable(before) === stable(next)) return bytes
	const original = fields(bytes)
	const replacements = new Map<number, Uint8Array>()
	for (const field of type.fieldsArray) {
		if (stable(before[field.name]) === stable(next[field.name])) continue
		const value = next[field.name]
		const oldFields = original.filter((item) => item.number === field.id)
		if (value === undefined) {
			if (
				field.resolvedType instanceof protobuf.Type &&
				!field.map &&
				oldFields.some((item) => hasUnknown(field.resolvedType as Type, item.data))
			)
				throw new Error(`${field.name}: cannot remove opaque nested messages`)
			replacements.set(field.id, new Uint8Array())
		} else if (field.resolvedType instanceof protobuf.Type && !field.map) {
			if (!field.repeated && oldFields.length > 1)
				throw new Error(`${field.name}: cannot edit a merged duplicate message`)
			const values = field.repeated ? value : [value]
			// Repeated messages with opaque children cannot safely be reordered by index.
			if (
				field.repeated &&
				values.length !== oldFields.length &&
				oldFields.some((f) => hasUnknown(field.resolvedType as Type, f.data))
			)
				throw new Error(`${field.name}: cannot resize opaque repeated messages`)
			if (
				field.repeated &&
				oldFields.some((item) => hasUnknown(field.resolvedType as Type, item.data))
			) {
				const oldValues = before[field.name] as RecordData[]
				if (
					values.some(
						(item: RecordData, index: number) =>
							stable(item) !== stable(oldValues[index]) &&
							oldValues.some((old, oldIndex) => oldIndex !== index && stable(old) === stable(item))
					)
				)
					throw new Error(`${field.name}: cannot reorder opaque repeated messages`)
			}
			replacements.set(
				field.id,
				join(
					values.map((item: RecordData, index: number) =>
						messageField(
							field.id,
							update(field.resolvedType as Type, oldFields[index]?.data ?? new Uint8Array(), item)
						)
					)
				)
			)
		} else {
			if (field.map && oldFields.some((f) => fields(f.data).some((child) => child.number > 2)))
				throw new Error(`${field.name}: cannot edit opaque map entries`)
			replacements.set(field.id, encodeField(type, field, value))
		}
	}
	const written = new Set<number>()
	const result: Uint8Array[] = []
	for (const field of original) {
		if (!replacements.has(field.number)) result.push(field.raw)
		else if (!written.has(field.number)) {
			result.push(replacements.get(field.number)!)
			written.add(field.number)
		}
	}
	for (const [number, replacement] of replacements)
		if (!written.has(number)) result.push(replacement)
	return join(result)
}

export function hasUnknown(type: Type, bytes: Uint8Array): boolean {
	return fields(bytes).some((field) => {
		const descriptor = type.fieldsById[field.number]
		return (
			!descriptor ||
			(descriptor.resolvedType instanceof protobuf.Type &&
				!descriptor.map &&
				hasUnknown(descriptor.resolvedType, field.data))
		)
	})
}

export function definition(type: Type): RecordData {
	return Object.fromEntries(
		type.fieldsArray.map((field) => [
			field.name,
			{
				type: field.resolvedType?.fullName ?? field.type,
				repeated: field.repeated,
				map: field.map,
			},
		])
	)
}
