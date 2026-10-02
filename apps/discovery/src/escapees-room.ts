import type { EscapeesVolume } from './escapees-snapshot'

// Fields follow the attached PersistedRoomData, PersistenceViewData, ShapeContainerData,
// ShapeData, TransformData and Vector3Data protobuf definitions. Native room exports
// identify shape_type 19 as Cube and 20 as Sphere.
const SHAPE_CONTAINER_PREFAB = hex('ba11967cdf3947478b14d93cfd65726d')
// Rec Room stores a custom RGB color as its 0xRRGGBB value plus 1000;
// shape_material 0 is Cardboard, and uv_scale 50 is material size 5000.
const CUSTOM_COLOR_OFFSET = 1000
const CARDBOARD_MATERIAL = 0
const MATERIAL_SIZE_5000 = 50
const PALETTE = [
	0x7a2428, 0xd94a4f, 0xf29a9d, 0x8a4b1f, 0xe67e2e, 0xf5b778, 0x8a741f, 0xe4c43a, 0xf3e58b,
	0x356b32, 0x5fae58, 0xa1d79c, 0x2c6664, 0x4fa7a3, 0x9ad4d1, 0x315a8a, 0x4c83c4, 0x9abbe0,
	0x5c3b7a, 0x8b62b0, 0xc3a3da, 0x7d3c61, 0xc45f92, 0xe5a6c4, 0x5d412e, 0x946746, 0xc5a17e,
	0x44474d, 0x777b83, 0xb5b8be, 0xf2f2f2, 0x222226,
] as const

function hex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))
}

function join(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0
	for (const part of parts) {
		output.set(part, offset)
		offset += part.length
	}
	return output
}

function varint(value: number): Uint8Array {
	const bytes: number[] = []
	do {
		let next = value % 128
		value = Math.floor(value / 128)
		if (value) next |= 128
		bytes.push(next)
	} while (value)
	return Uint8Array.from(bytes)
}

function numberField(field: number, value: number): Uint8Array {
	return join([varint(field * 8), varint(value)])
}

function bytesField(field: number, value: Uint8Array): Uint8Array {
	return join([varint(field * 8 + 2), varint(value.length), value])
}

function floatField(field: number, value: number): Uint8Array {
	const bytes = new Uint8Array(4)
	new DataView(bytes.buffer).setFloat32(0, value, true)
	return join([varint(field * 8 + 5), bytes])
}

function vector(x: number, y: number, z: number): Uint8Array {
	return join([floatField(1, x), floatField(2, y), floatField(3, z)])
}

function guidBytes(): Uint8Array {
	return hex(crypto.randomUUID().replaceAll('-', ''))
}

export function escapeesVolumeView(volume: EscapeesVolume): Uint8Array {
	const [sx, sy, sz] = volume.size
	const scale = Math.max(sx, sy, sz)
	const [x, y, z] = volume.origin
	const center = vector(x + sx / 2, y + sy / 2, z + sz / 2)
	const shape = join([
		numberField(1, volume.shape === 'box' ? 19 : 20),
		numberField(2, PALETTE[volume.colorIndex]! + CUSTOM_COLOR_OFFSET),
		// Shape meshes occupy [0, 1] on each axis in native exports. Their local
		// corner starts half a size below the centered container transform.
		bytesField(7, vector(-sx / 2, -sy / 2, -sz / 2)),
		bytesField(8, new Uint8Array()),
		floatField(11, 10),
		bytesField(12, guidBytes()),
		floatField(13, scale),
		floatField(15, MATERIAL_SIZE_5000),
		bytesField(16, bytesField(2, vector(sx / scale, sy / scale, sz / scale))),
		numberField(18, CARDBOARD_MATERIAL),
		numberField(19, 1),
	])
	const collection = bytesField(1, shape)
	const container = join([bytesField(1, collection), numberField(4, 1)])
	const transform = join([bytesField(1, center), floatField(5, 1)])
	return join([
		bytesField(1, guidBytes()),
		bytesField(9, new Uint8Array()),
		bytesField(10, transform),
		bytesField(11, bytesField(1, SHAPE_CONTAINER_PREFAB)),
		bytesField(12, container),
		bytesField(14, numberField(4, 1)),
		bytesField(15, bytesField(1, bytesField(1, new TextEncoder().encode('makerpenobject')))),
		bytesField(22, new Uint8Array()),
	])
}

/** Build a room-save protobuf from the clean, object-free starter scene. */
export function buildEscapeesRoom(
	base: Uint8Array,
	volumes: EscapeesVolume[],
	onChunk?: (done: number) => void
): Uint8Array {
	const parts = [base]
	for (let i = 0; i < volumes.length; i++) {
		parts.push(bytesField(2, escapeesVolumeView(volumes[i]!)))
		if ((i + 1) % 256 === 0) onChunk?.(i + 1)
	}
	onChunk?.(volumes.length)
	return join(parts)
}

/** Yield between batches so a large map does not monopolize Railway's event loop. */
export async function buildEscapeesRoomAsync(
	base: Uint8Array,
	volumes: EscapeesVolume[],
	onProgress: (fraction: number) => Promise<void>
): Promise<Uint8Array> {
	const parts = [base]
	for (let i = 0; i < volumes.length; i++) {
		parts.push(bytesField(2, escapeesVolumeView(volumes[i]!)))
		if ((i + 1) % 1024 === 0) {
			await onProgress((i + 1) / volumes.length)
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
		}
	}
	await onProgress(1)
	return join(parts)
}
