import { expect, it } from 'vitest'

import { forceRoomVersionOne, isBinpbScene } from '../room-converter'

function varint(value: bigint): number[] {
	const out: number[] = []
	for (;;) {
		const byte = Number(value & 0x7fn)
		value >>= 7n
		if (value) out.push(byte | 0x80)
		else {
			out.push(byte)
			return out
		}
	}
}

const num = (field: number, value: bigint | number) => [
	...varint(BigInt(field << 3)),
	...varint(BigInt(value)),
]
const len = (field: number, payload: number[]) => [
	...varint(BigInt((field << 3) | 2)),
	...varint(BigInt(payload.length)),
	...payload,
]
const text = (value: string) => [...new TextEncoder().encode(value)]

it('defaults version forcing for .binpb files', () => {
	expect(isBinpbScene('MyRoom.binpb')).toBe(true)
	expect(isBinpbScene('MYROOM.BINPB')).toBe(true)
	expect(isBinpbScene('MyRoom.room')).toBe(false)
})

it('changes only the version and retains circuits and object data', () => {
	const circuit = len(28, text('Circuit Board'))
	const object = len(2, [
		...num(3, 7),
		...num(100, 0xffff_ffff_ffff_ffffn),
		...len(14, [...num(1, 4), ...len(5, text('uuid'))]),
		...circuit,
	])
	const input = [...num(1, 38), ...object, ...circuit, ...num(30, 141)]
	const output = forceRoomVersionOne(Uint8Array.from(input))
	expect([...output]).toEqual([...num(1, 38), ...object, ...circuit, ...num(30, 1)])
})

it('changes every top-level version when the field occurs twice', () => {
	const input = [...num(30, 141), ...len(2, num(30, 222)), ...num(30, 123)]
	expect([...forceRoomVersionOne(Uint8Array.from(input))]).toEqual([
		...num(30, 1),
		...len(2, num(30, 222)),
		...num(30, 1),
	])
})

it('leaves a scene already at version 1 unchanged', () => {
	const input = Uint8Array.from([...num(1, 38), ...num(30, 1)])
	expect(forceRoomVersionOne(input)).toEqual(input)
})

it('rejects a scene without a top-level persistence version', () => {
	expect(() => forceRoomVersionOne(Uint8Array.from(len(2, num(30, 141))))).toThrow(
		'Scene data has no persistence version'
	)
})
