/** Version limits observed from the July 18, 2025 client and its saved room data. */
export const JULY_2025_ROOM_IMPORT_VERSIONS = {
	// Reported as the current scene version in Player.log when a newer room is rejected.
	scene: 141,
	// Embedded in a scene the client saved on this server.
	circuitsV2: 104,
	// Sent by the client in POST /rooms/{id}/subrooms/{id}/data.
	savePersistence: 227,
} as const
