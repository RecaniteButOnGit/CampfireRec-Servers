import { inflateSync } from 'fflate'

/** EscapeesEditNetwork's map-save format (versions 1–3), not a Rec Room protobuf. */
export interface EscapeesVolume {
	shape: 'box' | 'ball'
	origin: [number, number, number]
	size: [number, number, number]
	colorIndex: number
	material: number
}

export interface EscapeesSpawn {
	kind: 'playerSpawn' | 'monsterSpawn' | 'monsterWander'
	origin: [number, number, number]
}

export interface EscapeesLight {
	kind: 'light'
	origin: [number, number, number]
	intensityPreset: number
}

export type EscapeesObject = EscapeesVolume | EscapeesSpawn | EscapeesLight

const MAX_DECODED_BYTES = 24 * 1024 * 1024
const MAX_RECORDS = 1_000_000
const MAX_IMPORT_OBJECTS = 100_000
const GRID = 0.1

class Reader {
	readonly view: DataView
	readonly bytes: Uint8Array
	position = 0
	constructor(bytes: Uint8Array) {
		this.bytes = bytes
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	}
	need(length: number) {
		if (this.position + length > this.bytes.length)
			throw new Error('The Escapees map data is incomplete.')
	}
	u8(): number {
		this.need(1)
		return this.view.getUint8(this.position++)
	}
	i16(): number {
		this.need(2)
		const value = this.view.getInt16(this.position, true)
		this.position += 2
		return value
	}
	u16(): number {
		this.need(2)
		const value = this.view.getUint16(this.position, true)
		this.position += 2
		return value
	}
	i32(): number {
		this.need(4)
		const value = this.view.getInt32(this.position, true)
		this.position += 4
		return value
	}
	skip(length: number) {
		this.need(length)
		this.position += length
	}
	varuint(): number {
		let value = 0
		for (let shift = 0; shift <= 28; shift += 7) {
			const next = this.u8()
			if (shift === 28 && (next & 0x7f) > 7) throw new Error('The Escapees map data is invalid.')
			value += (next & 0x7f) * 2 ** shift
			if (!(next & 0x80)) return value
		}
		throw new Error('The Escapees map data is invalid.')
	}
	gridPosition(): [number, number, number] {
		return [this.i16() * GRID, this.i16() * GRID, this.i16() * GRID]
	}
	gridSize(): [number, number, number] {
		return [this.u16() * GRID, this.u16() * GRID, this.u16() * GRID]
	}
	packedSize(): [number, number, number] {
		this.need(5)
		let packed = 0
		for (let i = 0; i < 5; i++) packed += this.u8() * 2 ** (8 * i)
		if (Math.floor(packed / 2 ** 33) !== 0) throw new Error('The Escapees map data is invalid.')
		return [0, 11, 22].map((shift) => (Math.floor(packed / 2 ** shift) % 2048) * GRID) as [
			number,
			number,
			number,
		]
	}
	packedLight(): { origin: [number, number, number]; intensityPreset: number } {
		this.need(6)
		let packed = 0
		for (let i = 0; i < 6; i++) packed += this.u8() * 2 ** (8 * i)
		if (Math.floor(packed / 2 ** 44) !== 0)
			throw new Error('The Escapees map has an invalid light.')
		const coordinate = (shift: number) => ((Math.floor(packed / 2 ** shift) % 8192) - 4000) * GRID
		return {
			origin: [coordinate(0), coordinate(13), coordinate(26)],
			intensityPreset: Math.floor(packed / 2 ** 39) % 32,
		}
	}
}

/** Reject malformed records rather than importing a partial room. */
export function decodeEscapeesSnapshot(bytes: Uint8Array): EscapeesObject[] {
	const outer = new Reader(bytes)
	const version = outer.u8()
	if (version < 1 || version > 3)
		throw new Error('This Escapees map save version is not supported.')
	let reader = outer
	if (version >= 2) {
		const encoding = outer.u8()
		if (encoding === 1) {
			const length = outer.i32()
			if (length < 4 || length > MAX_DECODED_BYTES)
				throw new Error('The Escapees map is too large to import.')
			const inflated = inflateSync(bytes.subarray(outer.position), { out: new Uint8Array(length) })
			if (inflated.length !== length) throw new Error('The Escapees map data is invalid.')
			reader = new Reader(inflated)
		} else if (encoding === 0) {
			if (bytes.length - outer.position > MAX_DECODED_BYTES)
				throw new Error('The Escapees map is too large to import.')
			reader = new Reader(bytes.subarray(outer.position))
		} else throw new Error('This Escapees map encoding is not supported.')
	}
	const count = reader.i32()
	if (count < 0 || count > MAX_RECORDS) throw new Error('The Escapees map data is invalid.')
	const objects: EscapeesObject[] = []
	let previousId = 0
	for (let i = 0; i < count; i++) {
		const id = version === 1 ? reader.i32() : previousId + reader.varuint()
		if (id <= previousId || id > 0x7fffffff) throw new Error('The Escapees map data is invalid.')
		previousId = id
		const type = reader.u8()
		if (type < 0 || type > 4) throw new Error('The Escapees map has an unknown object type.')
		if (objects.length >= MAX_IMPORT_OBJECTS)
			throw new Error('This Escapees map has too many objects to import.')
		if (type === 0) {
			const style = reader.u8()
			const shape = version === 1 ? style : style & 1
			const origin = reader.gridPosition()
			const size = version === 1 ? reader.gridSize() : reader.packedSize()
			const colorIndex = version === 1 ? reader.u8() : style >> 3
			const material = version === 1 ? reader.u8() : (style >> 1) & 3
			if (shape > 1 || colorIndex > 31 || material > 3 || size.some((n) => n < GRID || n > 102.4)) {
				throw new Error('The Escapees map has an invalid volume.')
			}
			objects.push({ shape: shape === 0 ? 'box' : 'ball', origin, size, colorIndex, material })
		} else if (type === 4) {
			const light =
				version === 3
					? reader.packedLight()
					: { origin: reader.gridPosition(), intensityPreset: 30 }
			objects.push({ kind: 'light', ...light })
		} else {
			objects.push({
				kind: type === 1 ? 'playerSpawn' : type === 2 ? 'monsterSpawn' : 'monsterWander',
				origin: reader.gridPosition(),
			})
		}
	}
	if (reader.position !== reader.bytes.length) throw new Error('The Escapees map data is invalid.')
	return objects
}
