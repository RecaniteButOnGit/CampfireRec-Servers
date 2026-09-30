import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'

export interface ArchiveSubRoom {
	details: Record<string, unknown>
	save: Record<string, unknown>
	file: File
	originalFile?: File
}

export interface ArchiveAudio {
	blobName: string
	file: File
}

export interface RoomArchive {
	details: Record<string, unknown>
	image: File
	subRooms: ArchiveSubRoom[]
	audio: ArchiveAudio[]
	skippedSubRooms: number
}

const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
// CV2 `.htr.binpb` recordings can make the selected import payload much larger than
// ordinary room scenes. Keep the filtered payload bounded while allowing large rooms.
const MAX_EXTRACTED_BYTES = 384 * 1024 * 1024
const text = new TextDecoder()
const EXPORTED_AUDIO_ENTRY =
	/(?:^|\/)(?:CV2Audio\/Node_SampleAudio_|AudioSampler\/PVHolotar_|Holotar\/PVHolotar_)([a-z0-9]{16,64}\.htr)\.binpb$/i

function selectedEntry(name: string): boolean {
	return (
		/(?:^|\/)(?:RoomDetails\.json|RoomImage\.(?:jpe?g|png)|Subroom\.json|persisted_room_data\.(?:original\.binpb|binpb|room))$/i.test(
			name
		) || EXPORTED_AUDIO_ENTRY.test(name)
	)
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
	const output = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.length
	}
	return output
}

/** Stream only importer-relevant entries so multi-gigabyte exports don't fill browser RAM. */
async function extractSelectedEntries(file: File): Promise<Record<string, Uint8Array>> {
	const files: Record<string, Uint8Array> = {}
	let extractedBytes = 0
	let streamError: Error | undefined
	const unzipper = new Unzip()
	unzipper.register(UnzipPassThrough)
	unzipper.register(UnzipInflate)
	unzipper.onfile = (entry) => {
		// Some Windows exporters write backslash separators in ZIP paths. Normalize
		// before matching subroom files and deriving roots.
		const name = entry.name.replaceAll('\\', '/')
		if (!selectedEntry(name)) return
		if (entry.originalSize !== undefined && entry.originalSize > MAX_ENTRY_BYTES) {
			streamError = new Error(`Archive entry is too large: ${name}`)
			return
		}
		const chunks: Uint8Array[] = []
		let entryBytes = 0
		entry.ondata = (error, chunk, final) => {
			if (error) {
				streamError = asError(error)
				return
			}
			if (chunk) {
				entryBytes += chunk.length
				extractedBytes += chunk.length
				if (entryBytes > MAX_ENTRY_BYTES) {
					streamError = new Error(`Archive entry is too large: ${name}`)
					return
				}
				if (extractedBytes > MAX_EXTRACTED_BYTES) {
					streamError = new Error('The extracted room is too large.')
					return
				}
				chunks.push(chunk)
			}
			if (final && !streamError) files[name] = joinChunks(chunks, entryBytes)
		}
		try {
			entry.start()
		} catch (error) {
			streamError = asError(error)
		}
	}

	const reader = file.stream().getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			unzipper.push(value ?? new Uint8Array(0), done)
			if (streamError) throw streamError
			if (done) break
		}
		return files
	} catch (error) {
		await reader.cancel().catch(() => undefined)
		if (error instanceof Error && /too large/i.test(error.message)) throw error
		throw new Error('Could not read this ZIP as a room export.')
	} finally {
		reader.releaseLock()
	}
}

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

/** Read importable metadata and blobs; large GLBs and WAV previews stay compressed. */
export async function readRoomArchive(file: File): Promise<RoomArchive> {
	if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Choose a .zip room export.')
	if (file.size > MAX_ZIP_BYTES) throw new Error('This ZIP is too large to import (maximum 2 GiB).')
	const files = await extractSelectedEntries(file)
	const entries = Object.entries(files)
	const detailFiles = entries.filter(([name]) => /(?:^|\/)RoomDetails\.json$/i.test(name))
	if (detailFiles.length !== 1) throw new Error('The ZIP must contain one RoomDetails.json.')
	const [detailsPath, detailsBytes] = detailFiles[0]!
	const root = detailsPath.slice(0, -'RoomDetails.json'.length)
	const details = jsonObject(detailsBytes, 'RoomDetails.json')
	const name = details.Name
	if (typeof name !== 'string' || !name.trim())
		throw new Error('RoomDetails.json has no room name.')
	const imageEntry = entries.find(
		([path]) => path.startsWith(root) && /^RoomImage\.(?:jpe?g|png)$/i.test(path.slice(root.length))
	)
	if (!imageEntry) throw new Error('The ZIP has no RoomImage.jpg or RoomImage.png.')
	const [imagePath, imageBytes] = imageEntry
	const imageType = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg'
	const image = new File([new Uint8Array(imageBytes)], imagePath.split('/').pop()!, {
		type: imageType,
	})
	// The scene stores each sample's original `.htr` blob name. WAV files in the
	// export are decoded previews; the `.binpb` bytes are what the client fetches.
	const audioByName = new Map<string, Uint8Array>()
	for (const [path, bytes] of entries) {
		if (!path.startsWith(root)) continue
		const match = EXPORTED_AUDIO_ENTRY.exec(path)
		if (!match) continue
		const blobName = match[1]!.toLowerCase()
		const previous = audioByName.get(blobName)
		if (
			previous &&
			(previous.length !== bytes.length || previous.some((byte, i) => byte !== bytes[i]))
		)
			throw new Error(`Archive has conflicting sample audio for ${blobName}.`)
		audioByName.set(blobName, bytes)
	}
	const audio: ArchiveAudio[] = [...audioByName].map(([blobName, bytes]) => ({
		blobName,
		file: new File([new Uint8Array(bytes)], `${blobName}.binpb`, {
			type: 'application/octet-stream',
		}),
	}))
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
		const originalEntry = entries.find(
			([scenePath]) =>
				scenePath.startsWith(dir) &&
				/^persisted_room_data\.original\.binpb$/i.test(scenePath.slice(dir.length))
		)
		if (!sceneEntry && !originalEntry) continue
		const subDetails = jsonObject(bytes, 'Subroom.json')
		const save = subDetails.CurrentSave
		if (!save || typeof save !== 'object' || Array.isArray(save)) continue
		// A UnityAssetId marks an RRS-backed save. The current game build cannot load it.
		if (typeof (save as Record<string, unknown>).UnityAssetId === 'string') continue
		const [scenePath, sceneBytes] = sceneEntry ?? originalEntry!
		subRooms.push({
			details: subDetails,
			save: save as Record<string, unknown>,
			file: new File([new Uint8Array(sceneBytes)], scenePath.split('/').pop()!, {
				type: 'application/octet-stream',
			}),
			...(originalEntry
				? {
						originalFile: new File(
							[new Uint8Array(originalEntry[1])],
							originalEntry[0].split('/').pop()!,
							{ type: 'application/octet-stream' }
						),
					}
				: {}),
		})
	}
	if (subRooms.length === 0) throw new Error('The ZIP has no subroom with scene data to import.')
	const listed = Array.isArray(details.SubRooms) ? details.SubRooms.length : subRooms.length
	return { details, image, subRooms, audio, skippedSubRooms: Math.max(0, listed - subRooms.length) }
}
