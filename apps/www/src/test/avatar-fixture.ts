function concat(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
	let position = 0
	for (const part of parts) {
		result.set(part, position)
		position += part.length
	}
	return result
}

function message(number: number, value: Uint8Array): Uint8Array {
	return concat(new Uint8Array([number * 8 + 2, value.length]), value)
}

/** A minimal AvatarData wire shape: one head item and a skin color GUID. */
export const avatarDataFixture = concat(
	new Uint8Array([8, 10]),
	message(
		2,
		concat(
			new Uint8Array([8, 1]),
			message(2, message(1, message(1, Uint8Array.from(Array(16).keys()))))
		)
	),
	message(3, message(1, Uint8Array.from(Array(16).keys())))
)
