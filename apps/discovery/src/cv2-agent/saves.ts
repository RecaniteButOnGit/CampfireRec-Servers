import { appendSubRoomSaveIfLatest, getRoomById, getSubRoomSaves } from '@repo/domain'

import { equalBytes, RoomDocument } from './room'
import { RoomWorkspace } from './workspace'

import type { SubRoom, SubRoomDataSave } from '@repo/domain'
import type { Env } from '../context'
import type { Compilation } from './workspace'

export class AgentFailure extends Error {}
export class SaveConflict extends AgentFailure {}
export type Snapshot = {
	save: SubRoomDataSave
	expected: { latest: number; current: number | null; staged: number | null }
	sub: SubRoom
	publish: boolean
	accountId: number
}
export async function snapshot(env: Env, roomId: number, subRoomId: number): Promise<Snapshot> {
	const room = await getRoomById(env.DB, roomId)
	const sub = (room?.SubRooms as SubRoom[] | undefined)?.find((sub) => sub.SubRoomId === subRoomId)
	if (!room || !sub) throw new AgentFailure('Room or subroom no longer exists')
	const saves = await getSubRoomSaves(env.DB, subRoomId)
	const latest = saves[0]
	if (!latest || typeof latest.DataBlob !== 'string' || !latest.DataBlob)
		throw new AgentFailure('Latest room save has no valid scene blob')
	if (Number(latest.ModerationState ?? 0) !== 0)
		throw new AgentFailure('Latest room save is not valid for editing')
	return {
		save: latest,
		sub,
		expected: {
			latest: Number(latest.SubRoomDataSaveId),
			current: ((sub.CurrentSave as SubRoomDataSave | null)?.SubRoomDataSaveId as number) ?? null,
			staged: typeof sub.StagedSubRoomDataSaveId === 'number' ? sub.StagedSubRoomDataSaveId : null,
		},
		publish: room.IsDorm === true,
		accountId: Number(room.CreatorAccountId),
	}
}

export async function loadSave(env: Env, save: SubRoomDataSave): Promise<Uint8Array> {
	const key = String(save.DataBlob)
	if (!key || key.includes('..') || key.startsWith('/') || key.includes('://'))
		throw new AgentFailure('Invalid room blob key')
	const stored = await env.CDN_ASSETS.get(`room/${key}`)
	if (!stored || stored.size > 32 * 1024 * 1024)
		throw new AgentFailure('Room save is missing or exceeds 32 MiB')
	const bytes = new Uint8Array(await stored.arrayBuffer())
	// Campfire's native scene uploads and Escapees encoder use raw protobuf.
	// Never guess the interpretation of a compressed or encrypted export.
	try {
		new RoomDocument(bytes)
	} catch {
		throw new AgentFailure('Room save is not a supported raw PersistedRoomData protobuf')
	}
	return bytes
}

export function saveComment(prompt: string): string {
	const safe = prompt
		.replace(/[\p{Cc}\p{Cf}"\\]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return `AI Run "${Array.from(safe).slice(0, 200).join('')}" Complete`
}

/** Upload under a new UUID, then atomically append; remove rejected blobs. */
export async function commitSave(
	env: Env,
	roomId: number,
	subRoomId: number,
	runId: string,
	prompt: string,
	base: Snapshot,
	workspace: RoomWorkspace,
	compiled: Compilation,
	log: (message: string) => void,
	leaseRunId?: string
): Promise<number> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		log(`Checking save version (attempt ${attempt})`)
		const current = await snapshot(env, roomId, subRoomId)
		let bytes = compiled.bytes
		if (current.expected.latest !== base.expected.latest) {
			log(`Newer save ${current.expected.latest}; attempting component rebase`)
			const latest = new RoomWorkspace(new RoomDocument(await loadSave(env, current.save)))
			try {
				bytes = workspace.rebase(latest, compiled)
			} catch {
				throw new SaveConflict('Room changed during AI run and automatic rebase was unsafe')
			}
		} else if (
			current.expected.current !== base.expected.current ||
			current.expected.staged !== base.expected.staged
		) {
			throw new SaveConflict('Published/staged save changed during AI run')
		} else if (!equalBytes(await loadSave(env, current.save), workspace.document.bytes)) {
			throw new SaveConflict('Base scene blob changed in place during AI run')
		}
		new RoomWorkspace(new RoomDocument(bytes)).compile()
		const blob = `${runId}_${crypto.randomUUID()}.room`
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
		const hashBase64 = btoa(Array.from(hash, (byte) => String.fromCharCode(byte)).join(''))
		log('Uploading validated save')
		await env.CDN_ASSETS.put(`room/${blob}`, bytes, {
			httpMetadata: { contentType: 'application/octet-stream' },
		})
		let saved: SubRoomDataSave | null
		try {
			saved = await appendSubRoomSaveIfLatest(
				env.DB,
				roomId,
				subRoomId,
				current.accountId,
				current.save,
				{ ...current.expected, runId: leaseRunId },
				{
					dataBlob: blob,
					dataBlobHash: hashBase64,
					description: saveComment(prompt),
					publish: current.publish,
				}
			)
		} catch {
			// A transport failure can happen after commit. Resolve it before cleanup.
			const history = await getSubRoomSaves(env.DB, subRoomId).catch(() => null)
			const committed = history?.find((save) => save.DataBlob === blob)
			if (committed) return Number(committed.SubRoomDataSaveId)
			if (history) await env.CDN_ASSETS.delete(`room/${blob}`).catch(() => {})
			throw new AgentFailure('Save commit failed; check run history before retrying')
		}
		if (saved) {
			log(
				`Created save ${saved.SubRoomDataSaveId}${current.publish ? ' (published dorm save)' : ' (staged for the room owner)'}`
			)
			return Number(saved.SubRoomDataSaveId)
		}
		await env.CDN_ASSETS.delete(`room/${blob}`).catch(() => {})
		if (leaseRunId) {
			const active = await env.DB.prepare(
				"SELECT 1 FROM cv2_agent_run WHERE run_id=?1 AND state='running' AND deadline_at>?2"
			)
				.bind(leaseRunId, new Date().toISOString())
				.first()
			if (!active)
				throw new AgentFailure(
					'Run expired or was stopped before commit; uploaded blob was discarded'
				)
		}
		log('Save changed at commit; discarded uploaded blob and retrying rebase')
	}
	throw new SaveConflict('Room kept changing during save commit; no AI save was created')
}
