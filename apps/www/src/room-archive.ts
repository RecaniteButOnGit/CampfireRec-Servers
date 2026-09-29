import { unzipSync } from 'fflate'

export interface ArchiveSubRoom {
	details: Record<string, unknown>
	save: Record<string, unknown>
	file: File
}

export interface RoomArchive {
	details: Record<string, unknown>
	image: File
	subRooms: ArchiveSubRoom[]
	skippedSubRooms: number
}

const MAX_ZIP_BYTES = 256 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
const text = new TextDecoder()

function jsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(text.decode(bytes))
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			return value as Record<string, unknown>
		}
	} catch {
		// The same useful error covers invalid JSON and a non-object JSON value.
	}
	throw new Error(`${label} is not valid room metadata.`)
}

/** Read only the files the importer uses; large GLBs, inventions and auxiliary assets stay compressed. */
export async function readRoomArchive(file: File): Promise<RoomArchive> {
	if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Choose a .zip room export.')
	if (file.size > MAX_ZIP_BYTES) throw new Error('This ZIP is too large to import in the browser.')
	let extractedBytes = 0
	let files: Record<string, Uint8Array>
	try {
		files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
			filter: ({ name, originalSize }) => {
				const wanted = /(?:^|\/)(?:RoomDetails\.json|RoomImage\.(?:jpe?g|png)|Subroom\.json|persisted_room_data\.(?:binpb|room))$/i.test(name)
				if (!wanted) return false
				if (originalSize > MAX_ENTRY_BYTES) throw new Error(`Archive entry is too large: ${name}`)
				extractedBytes += originalSize
				if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('The extracted room is too large.')
				return true
			},
		})
	} catch (error) {
		if (error instanceof Error && /too large/i.test(error.message)) throw error
		throw new Error('Could not read this ZIP as a room export.')
	}
	const entries = Object.entries(files)
	const detailFiles = entries.filter(([name]) => /(?:^|\/)RoomDetails\.json$/i.test(name))
	if (detailFiles.length !== 1) throw new Error('The ZIP must contain one RoomDetails.json.')
	const [detailsPath, detailsBytes] = detailFiles[0]!
	const root = detailsPath.slice(0, -'RoomDetails.json'.length)
	const details = jsonObject(detailsBytes, 'RoomDetails.json')
	const name = details.Name
	if (typeof name !== 'string' || !name.trim()) throw new Error('RoomDetails.json has no room name.')
	const imageEntry = entries.find(
		([path]) => path.startsWith(root) && /^RoomImage\.(?:jpe?g|png)$/i.test(path.slice(root.length))
	)
	if (!imageEntry) throw new Error('The ZIP has no RoomImage.jpg or RoomImage.png.')
	const [imagePath, imageBytes] = imageEntry
	const imageType = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg'
	const image = new File([new Uint8Array(imageBytes)], imagePath.split('/').pop()!, { type: imageType })
	const subRooms: ArchiveSubRoom[] = []
	for (const [path, bytes] of entries) {
		if (!path.startsWith(root) || !/\/Subroom\.json$/i.test(path)) continue
		const dir = path.slice(0, -'Subroom.json'.length)
		if (!/^SubRoom_/i.test(dir.slice(root.length))) continue
		const sceneEntry = entries.find(
			([scenePath]) =>
				scenePath.startsWith(dir) &&
				/^persisted_room_data\.(?:binpb|room)$/i.test(scenePath.slice(dir.length))
		)
		if (!sceneEntry) continue
		const subDetails = jsonObject(bytes, 'Subroom.json')
		const save = subDetails.CurrentSave
		if (!save || typeof save !== 'object' || Array.isArray(save)) continue
		const [scenePath, sceneBytes] = sceneEntry
		subRooms.push({
			details: subDetails,
			save: save as Record<string, unknown>,
			file: new File([new Uint8Array(sceneBytes)], scenePath.split('/').pop()!, {
				type: 'application/octet-stream',
			}),
		})
	}
	if (subRooms.length === 0) throw new Error('The ZIP has no subroom with scene data to import.')
	const listed = Array.isArray(details.SubRooms) ? details.SubRooms.length : subRooms.length
	return { details, image, subRooms, skippedSubRooms: Math.max(0, listed - subRooms.length) }
}
