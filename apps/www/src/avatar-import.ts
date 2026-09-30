import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'

import type { Outfit } from '@repo/domain/src/outfits-db'

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_AVATAR_BYTES = 1024 * 1024

type WireField = { wire: number; value: number | Uint8Array }
type Message = Map<number, WireField[]>

function readVarint(bytes: Uint8Array, position: { value: number }): number {
	let result = 0
	let factor = 1
	for (let i = 0; i < 10; i++) {
		if (position.value >= bytes.length) throw new Error('Truncated AvatarData.binpb.')
		const byte = bytes[position.value++]!
		result += (byte & 0x7f) * factor
		if (byte < 0x80) {
			if (!Number.isSafeInteger(result)) throw new Error('Invalid AvatarData.binpb integer.')
			return result
		}
		factor *= 128
	}
	throw new Error('Invalid AvatarData.binpb integer.')
}

/** Small wire decoder for the fields in rec_room.AvatarData from the supplied descriptor. */
function decode(bytes: Uint8Array): Message {
	const result: Message = new Map()
	const position = { value: 0 }
	while (position.value < bytes.length) {
		const tag = readVarint(bytes, position)
		const number = Math.floor(tag / 8)
		const wire = tag % 8
		if (number === 0) throw new Error('Invalid AvatarData.binpb field.')
		let value: number | Uint8Array
		switch (wire) {
			case 0:
				value = readVarint(bytes, position)
				break
			case 1:
				if (position.value + 8 > bytes.length) throw new Error('Truncated AvatarData.binpb.')
				value = bytes.subarray(position.value, position.value + 8)
				position.value += 8
				break
			case 2: {
				const size = readVarint(bytes, position)
				if (size > MAX_AVATAR_BYTES || position.value + size > bytes.length)
					throw new Error('Invalid AvatarData.binpb field length.')
				value = bytes.subarray(position.value, position.value + size)
				position.value += size
				break
			}
			case 5:
				if (position.value + 4 > bytes.length) throw new Error('Truncated AvatarData.binpb.')
				value = new DataView(bytes.buffer, bytes.byteOffset + position.value, 4).getFloat32(0, true)
				position.value += 4
				break
			default:
				throw new Error('Unsupported AvatarData.binpb wire type.')
		}
		const list = result.get(number) ?? []
		list.push({ wire, value })
		result.set(number, list)
	}
	return result
}

function bytes(message: Message, field: number): Uint8Array | undefined {
	const item = message.get(field)?.[0]
	if (!item) return undefined
	if (item.wire !== 2 || !(item.value instanceof Uint8Array))
		throw new Error('Invalid AvatarData.binpb field type.')
	return item.value
}

function nested(message: Message, field: number): Message {
	const value = bytes(message, field)
	return value ? decode(value) : new Map()
}

function integer(message: Message, field: number, fallback = 0): number {
	const item = message.get(field)?.[0]
	if (!item) return fallback
	if (item.wire !== 0 || typeof item.value !== 'number')
		throw new Error('Invalid AvatarData.binpb field type.')
	return item.value
}

function float(message: Message, field: number): number {
	const item = message.get(field)?.[0]
	if (!item) return 0
	if (item.wire !== 5 || typeof item.value !== 'number' || !Number.isFinite(item.value))
		throw new Error('Invalid AvatarData.binpb float.')
	return item.value
}

function guid(message: Message, field: number): { encoded: string; uuid: string } | null {
	const data = bytes(nested(message, field), 1)
	if (!data) return null
	if (data.length !== 16) throw new Error('Invalid AvatarData.binpb GUID.')
	let binary = ''
	for (const byte of data) binary += String.fromCharCode(byte)
	const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	// Unity/.NET Guid.ToByteArray stores the first three UUID components little endian.
	const hex = [...data].map((byte) => byte.toString(16).padStart(2, '0'))
	const uuid = `${hex[3]}${hex[2]}${hex[1]}${hex[0]}-${hex[5]}${hex[4]}-${hex[7]}${hex[6]}-${hex[8]}${hex[9]}-${hex.slice(10).join('')}`
	return { encoded, uuid }
}

function vector(message: Message, dimensions: 2 | 3): Record<string, number> {
	return dimensions === 2
		? { x: float(message, 1), y: float(message, 2) }
		: { x: float(message, 1), y: float(message, 2), z: float(message, 3) }
}

function feature(message: Message) {
	return {
		Id: guid(message, 1)?.encoded ?? '',
		PositionOffset: vector(nested(message, 2), 2),
		ScaleOffset: float(message, 3),
		Rotation: float(message, 4),
		Aspect: float(message, 5),
	}
}

function properties(message: Message, names: string[]): Record<string, number> {
	return Object.fromEntries(names.map((name, index) => [name, float(message, index + 1)]))
}

/** Convert an exported AvatarData proto to the two avatar formats our clients read. */
export function convertAvatarData(data: Uint8Array): {
	avatar: Record<string, unknown>
	worn: Outfit
	saved: Outfit
} {
	if (data.length === 0 || data.length > MAX_AVATAR_BYTES)
		throw new Error('AvatarData.binpb is empty or too large.')
	const source = decode(data)
	const selections = (source.get(2) ?? []).map((field) => {
		if (field.wire !== 2 || !(field.value instanceof Uint8Array))
			throw new Error('Invalid AvatarData.binpb selection.')
		const selection = decode(field.value)
		const item = nested(selection, 2)
		const prefab = guid(item, 1)
		if (!prefab) throw new Error('AvatarData.binpb has a selection without an item.')
		const material = guid(item, 2)
		const custom = guid(item, 3)
		const color = nested(item, 4)
		const bodyPart = integer(selection, 1)
		return {
			PrefabGuid: prefab.uuid,
			CombinationGuid: material?.uuid ?? '',
			BodyPart: bodyPart,
			UgcOutfitData: {
				BaseAvatarItemColor: {
					r: float(color, 1),
					g: float(color, 2),
					b: float(color, 3),
					a: float(color, 4),
				},
				CustomAvatarItemId: custom?.uuid ?? '',
			},
		}
	})
	if (selections.length === 0) throw new Error('AvatarData.binpb has no outfit selections.')
	if (selections.length > 128) throw new Error('AvatarData.binpb has too many outfit selections.')

	const skinColor = guid(source, 3)?.encoded ?? ''
	const bodyShape = guid(source, 4)?.encoded ?? ''
	const face = nested(source, 9)
	const eyes = feature(nested(face, 1))
	const brows = feature(nested(face, 2))
	const mouth = feature(nested(face, 3))
	const nose = feature(nested(face, 5))
	const hair = nested(source, 10)
	const beard = nested(source, 11)
	const hat = nested(source, 8)
	const hairColor = guid(hair, 2)?.encoded ?? guid(hair, 1)?.encoded ?? ''
	const faceFeatures = {
		// FaceFeatures has its own serializer version. AvatarData.avatar_version is
		// a protobuf schema version and must never be used here.
		ver: 6,
		eyeId: eyes.Id,
		eyePos: eyes.PositionOffset,
		eyeScl: eyes.ScaleOffset,
		eyeRot: eyes.Rotation,
		eyeAspect: eyes.Aspect,
		eyebrowId: brows.Id,
		eyebrowPos: brows.PositionOffset,
		eyebrowScl: brows.ScaleOffset,
		mouthId: mouth.Id,
		mouthPos: mouth.PositionOffset,
		mouthScl: mouth.ScaleOffset,
		noseId: nose.Id,
		nosePos: nose.PositionOffset,
		noseScl: nose.ScaleOffset,
		faceShapeId: guid(face, 4)?.encoded ?? '',
		bodyShapeId: bodyShape,
		hairPrimaryColorId: guid(hair, 1)?.encoded ?? '',
		hairSecondaryColorId: guid(hair, 2)?.encoded ?? '',
		hairPatternId: guid(hair, 3)?.encoded ?? '',
		beardColorId: guid(beard, 1)?.encoded ?? '',
		beardSecondaryColorId: guid(beard, 2)?.encoded ?? '',
		beardPatternId: guid(beard, 3)?.encoded ?? '',
		hideEars: integer(source, 5) !== 0,
		useHelmetHair: integer(source, 6),
		useHatAnchorParams: integer(source, 7) !== 0,
		hatAnchorParams: {
			NormalizedPosition: vector(nested(hat, 1), 2),
			HemisphereOffsets: vector(nested(hat, 2), 3),
			HemisphereRotations: vector(nested(hat, 3), 3),
		},
		headScale: float(face, 6),
		modernBeanHeadScale: float(face, 7),
		avatarBodyType: integer(source, 12),
		bodyPropertyData: properties(nested(source, 13), [
			'bicepWidth',
			'forearmWidth',
			'chestSize',
			'chestOut',
			'waistSize',
			'hipWidth',
			'neckLength',
			'neckThickness',
			'thighWidth',
			'calfWidth',
			'footWidth',
			'footSize',
			'shoulderWidth',
			'bellyOut',
		]),
		facePropertyData: properties(nested(source, 14), [
			'cheekPuff',
			'jawWidth',
			'jawInOut',
			'chinWidth',
			'chinSize',
			'earSize',
			'earAngle',
			'headStretch',
		]),
		nosePropertyData: properties(nested(source, 15), [
			'noseWidth',
			'noseHeight',
			'noseLength',
			'noseAngle',
			'noseBulge',
			'nosePinchFlair',
			'noseSneer',
			'noseTipScale',
		]),
		bodyPaint: guid(source, 16)?.encoded ?? '',
		auraId: integer(nested(source, 17), 1),
		baseAvatarType: '',
	}
	const selectionV1 = selections
		.map((selection) =>
			selection.UgcOutfitData.CustomAvatarItemId
				? [
						selection.PrefabGuid,
						selection.CombinationGuid,
						selection.UgcOutfitData.CustomAvatarItemId,
						'',
						selection.BodyPart,
					].join(',')
				: [selection.PrefabGuid, selection.CombinationGuid, selection.BodyPart].join(',')
		)
		.join(';')
	const selectionV2 = JSON.stringify({ selections })
	const faceJson = JSON.stringify(faceFeatures)
	const avatar = {
		OutfitSelections: selectionV1,
		OutfitSelectionsV2: selectionV2,
		FaceFeatures: faceJson,
		SkinColor: skinColor,
		HairColor: hairColor,
		CustomAvatarItems: selections
			.map((selection) => selection.UgcOutfitData.CustomAvatarItemId)
			.filter(Boolean),
	}
	const worn: Outfit = {
		DataVersion: 2,
		LegacyData: {
			SelectionsV1: selectionV1,
			SelectionsV2: selectionV2,
			FaceFeatures: faceJson,
			SkinColor: skinColor,
			HairColor: hairColor,
		},
		// The 2025 client parses this document as a newer, GUID-typed schema. The
		// protobuf export is newer and has different field names and GUID encoding.
		// A null value tells the client to load the complete LegacyData instead.
		CustomizationSettings: null,
		Selections: [],
		Slot: 0,
		Name: null,
		Accessibility: 1,
		ThumbnailFileName: null,
	}
	const saved: Outfit = { ...worn, Slot: 1, Name: 'Imported avatar' }
	return { avatar, worn, saved }
}

/** Accept the named file directly or find exactly one such file anywhere in a ZIP. */
export async function readAvatarUpload(file: File): Promise<Uint8Array> {
	if (file.size === 0 || file.size > MAX_UPLOAD_BYTES)
		throw new Error('The upload is empty or too large (maximum 8 MiB).')
	if (/^AvatarData\.binpb$/i.test(file.name)) {
		if (file.size > MAX_AVATAR_BYTES) throw new Error('AvatarData.binpb is too large.')
		return new Uint8Array(await file.arrayBuffer())
	}
	if (!/\.zip$/i.test(file.name)) throw new Error('Choose AvatarData.binpb or a ZIP containing it.')
	let found: Uint8Array | undefined
	let failure: Error | undefined
	let matches = 0
	const unzip = new Unzip()
	unzip.register(UnzipPassThrough)
	unzip.register(UnzipInflate)
	unzip.onfile = (entry) => {
		if (!/(?:^|\/)AvatarData\.binpb$/i.test(entry.name.replace(/\\/g, '/'))) return
		matches++
		if (matches > 1) {
			failure = new Error('The ZIP contains more than one AvatarData.binpb.')
			return
		}
		if (entry.originalSize !== undefined && entry.originalSize > MAX_AVATAR_BYTES) {
			failure = new Error('AvatarData.binpb in the ZIP is too large.')
			return
		}
		const chunks: Uint8Array[] = []
		let size = 0
		entry.ondata = (error, chunk, final) => {
			if (error) failure = new Error('Invalid avatar ZIP.')
			if (failure) return
			size += chunk.length
			if (size > MAX_AVATAR_BYTES) {
				failure = new Error('AvatarData.binpb in the ZIP is too large.')
				return
			}
			chunks.push(chunk)
			if (final) {
				found = new Uint8Array(size)
				let offset = 0
				for (const part of chunks) {
					found.set(part, offset)
					offset += part.length
				}
			}
		}
		entry.start()
	}
	try {
		unzip.push(new Uint8Array(await file.arrayBuffer()), true)
	} catch {
		throw new Error('Invalid avatar ZIP.')
	}
	if (failure) throw failure
	if (!found) throw new Error('The ZIP must contain exactly one AvatarData.binpb.')
	return found
}
