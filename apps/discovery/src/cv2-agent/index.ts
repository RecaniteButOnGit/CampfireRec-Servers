import { getRoomByName } from '@repo/domain'

import { authorizedToken, parseEnvelope, parseFields } from '../ai-request'
import { runAgent } from './agent'
import { equalBytes, RoomDocument } from './room'
import { AgentFailure, commitSave, loadSave, SaveConflict, snapshot } from './saves'
import { RoomWorkspace } from './workspace'

import type { SubRoom } from '@repo/domain'
import type { Env } from '../context'

type Run = {
	run_id: string
	request_id: string
	room_id: number
	sub_room_id: number
	prompt: string
	state: string
	base_save_id: number | null
	final_save_id: number | null
	error: string | null
	deadline_at: string
}
const RUN_FIELDS = new Set(['Room', 'SubRoom', 'Prompt', 'RequestId', 'Anticache'])
const STATUS_FIELDS = new Set(['Run', 'Anticache'])

export function agentResponse(value: string) {
	return [
		{
			id: value,
			sectionType: 13,
			sectionSubType: 'CV2AgentResponse',
			source: 'PageSource',
			sourceMetadata: value,
			displayMetadata: JSON.stringify({ DisplayTitle: value }),
		},
	]
}

async function readRun(env: Env, runId: string): Promise<Run | null> {
	return env.DB.prepare('SELECT * FROM cv2_agent_run WHERE run_id = ?1').bind(runId).first<Run>()
}

export async function startCV2Agent(
	value: string,
	env: Env,
	waitUntil: (task: Promise<unknown>) => void
): Promise<string | null> {
	const envelope = parseEnvelope(value, 'CV2AGENT[')
	if (!envelope || !(await authorizedToken(envelope.token, env))) return null
	const input = parseFields(envelope.body, RUN_FIELDS)
	if (
		!input?.Room?.trim() ||
		input.Room.length > 100 ||
		!input.Prompt?.trim() ||
		input.Prompt.length > 8000 ||
		(input.SubRoom?.length ?? 0) > 100 ||
		(input.RequestId?.length ?? 0) > 100
	)
		return 'Error:Use CV2AGENT[Room:"...",Prompt:"..."] with optional SubRoom and RequestId.'
	const runId = `cv2agent_${crypto.randomUUID().replaceAll('-', '')}`
	console.info(`[CV2 Agent][${runId}] Request received`)
	try {
		if (!env.DB || !env.CDN_ASSETS || !(await env.OPENAIKEY?.get())?.trim())
			throw new AgentFailure(
				'CV2 Agent is not configured (room storage and OPENAIKEY are required)'
			)
		const room = await getRoomByName(env.DB, input.Room.trim().replace(/^\^/, ''))
		if (!room) throw new AgentFailure('Room not found')
		const subs = room.SubRooms as SubRoom[]
		const sub = input.SubRoom
			? subs.find((sub) => String(sub.SubRoomId) === input.SubRoom || sub.Name === input.SubRoom)
			: subs[0]
		if (!sub) throw new AgentFailure('Subroom not found')
		const base = await snapshot(env, Number(room.RoomId), Number(sub.SubRoomId))
		const requestId = input.RequestId ? `${room.RoomId}:${sub.SubRoomId}:${input.RequestId}` : runId
		const prior = await env.DB.prepare(
			"SELECT * FROM cv2_agent_run WHERE request_id = ?1 OR (sub_room_id = ?2 AND state IN ('queued','running')) ORDER BY created_at DESC LIMIT 1"
		)
			.bind(requestId, sub.SubRoomId)
			.first<Run>()
		if (prior) {
			if (prior.prompt !== input.Prompt || prior.room_id !== Number(room.RoomId))
				throw new AgentFailure('A different request is already running or uses this RequestId')
			if (prior.state === 'queued') waitUntil(runCV2Agent(env, prior.run_id))
			return prior.run_id
		}
		const now = new Date().toISOString(),
			deadline = new Date(Date.now() + 15 * 60000).toISOString()
		const inserted = await env.DB.prepare(
			`INSERT OR IGNORE INTO cv2_agent_run (run_id,request_id,room_id,sub_room_id,prompt,state,base_save_id,created_at,updated_at,deadline_at) VALUES (?1,?2,?3,?4,?5,'queued',?6,?7,?7,?8)`
		)
			.bind(
				runId,
				requestId,
				room.RoomId,
				sub.SubRoomId,
				input.Prompt,
				base.expected.latest,
				now,
				deadline
			)
			.run()
		if (!inserted.meta.changes)
			throw new AgentFailure('Another run started for this subroom; retry with the same RequestId')
		console.info(
			`[CV2 Agent][${runId}] Room ${Number(room.RoomId)}, subroom ${Number(sub.SubRoomId)}`
		)
		waitUntil(runCV2Agent(env, runId))
		return runId
	} catch (error) {
		const reason = error instanceof AgentFailure ? error.message : 'CV2 Agent could not start'
		console.info(`[CV2 Agent][${runId}] FAILED: ${reason}`)
		return `Error:${reason}`
	}
}

export async function cv2AgentStatus(value: string, env: Env): Promise<string | null> {
	const envelope = parseEnvelope(value, 'CV2AGENTSTATUS[')
	if (!envelope || !(await authorizedToken(envelope.token, env))) return null
	const input = parseFields(envelope.body, STATUS_FIELDS)
	if (!input?.Run || !/^cv2agent_[a-f0-9]{32}$/.test(input.Run))
		return 'Error:Enter a valid CV2 Agent run ID.'
	let run: Run | null
	try {
		run = await readRun(env, input.Run)
	} catch {
		return 'Error:Run status is unavailable'
	}
	if (!run) return 'Error:Run not found'
	return run.state === 'done'
		? `done:Save:${run.final_save_id}`
		: run.state === 'failed' || run.state === 'aborted'
			? `Error:${run.state}:${run.error}`
			: `${run.state}:${run.run_id}`
}

export async function runCV2Agent(env: Env, runId: string): Promise<void> {
	const started = Date.now()
	const claimed = await env.DB.prepare(
		"UPDATE cv2_agent_run SET state='running',updated_at=?2 WHERE run_id=?1 AND state='queued' AND deadline_at>?2"
	)
		.bind(runId, new Date().toISOString())
		.run()
	if (!claimed.meta.changes) return
	let key = '',
		finalSaveId: number | null = null
	const log = (message: string) =>
		console.info(
			`[CV2 Agent][${runId}] ${message
				.replaceAll(key || '\u0000', '[redacted]')
				.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
				.slice(0, 1600)}`
		)
	try {
		const run = await readRun(env, runId)
		if (!run) throw new AgentFailure('Run record disappeared')
		key = (await env.OPENAIKEY?.get())?.trim() ?? ''
		if (!key) throw new AgentFailure('OPENAIKEY is not configured')
		log('Resolving latest save')
		const base = await snapshot(env, run.room_id, run.sub_room_id)
		await env.DB.prepare('UPDATE cv2_agent_run SET base_save_id=?2 WHERE run_id=?1')
			.bind(runId, base.expected.latest)
			.run()
		log(`Loaded save ${base.expected.latest}; decoding protobuf`)
		const bytes = await loadSave(env, base.save),
			workspace = new RoomWorkspace(new RoomDocument(bytes))
		log(`Found ${workspace.nodes.size} CV2 chips and ${workspace.files.size} disconnected graphs`)
		log(
			`Global registry: ${workspace.registry.info.publishedChipCount} published chips; schema ${workspace.registry.info.provenance.protobufSha256}`
		)
		if (!equalBytes(workspace.compile().bytes, bytes))
			throw new AgentFailure('Baseline CV2 round-trip failed')
		log('Baseline round-trip passed; starting GPT-6.1 Sol agent')
		const heartbeat = async () => {
			const now = new Date().toISOString()
			const result = await env.DB.prepare(
				"UPDATE cv2_agent_run SET updated_at=?2 WHERE run_id=?1 AND state='running' AND deadline_at>?2"
			)
				.bind(runId, now)
				.run()
			if (!result.meta.changes)
				throw new AgentFailure('Run expired or was stopped; no save will be created')
		}
		const compiled = await runAgent(
			workspace,
			run.prompt,
			key,
			log,
			heartbeat,
			Date.parse(run.deadline_at)
		)
		await heartbeat()
		finalSaveId = await commitSave(
			env,
			run.room_id,
			run.sub_room_id,
			runId,
			run.prompt,
			base,
			workspace,
			compiled,
			log,
			runId
		)
		log(`Complete; final save ${finalSaveId}; total duration ${Date.now() - started} ms`)
	} catch (error) {
		if (finalSaveId !== null) {
			log(`Save ${finalSaveId} was created; run status update failed`)
			return
		}
		const state = error instanceof SaveConflict ? 'aborted' : 'failed'
		const reason =
			error instanceof AgentFailure
				? error.message.replaceAll(key || '\u0000', '[redacted]').slice(0, 400)
				: 'Unexpected CV2 Agent failure; inspect run status'
		log(`${state.toUpperCase()}: ${reason}; total duration ${Date.now() - started} ms`)
		await env.DB.prepare(
			"UPDATE cv2_agent_run SET state=?2,error=?3,updated_at=?4 WHERE run_id=?1 AND state!='done'"
		)
			.bind(runId, state, reason, new Date().toISOString())
			.run()
			.catch(() => log('Run status could not be persisted'))
	}
}

/** Recover queued work; never rerun a model session that might still be publishing. */
export async function resumeCV2Agents(env: Env): Promise<void> {
	const now = new Date().toISOString()
	const expired = await env.DB.prepare(
		"UPDATE cv2_agent_run SET state='failed',error='Run deadline expired or server restarted during execution',updated_at=?1 WHERE state IN ('queued','running') AND deadline_at<=?1 RETURNING run_id"
	)
		.bind(now)
		.all<{ run_id: string }>()
	for (const run of expired.results)
		console.info(`[CV2 Agent][${run.run_id}] FAILED: run deadline expired`)
	const queued = await env.DB.prepare(
		"SELECT run_id FROM cv2_agent_run WHERE state='queued' ORDER BY created_at LIMIT 1"
	).first<{ run_id: string }>()
	if (queued) await runCV2Agent(env, queued.run_id)
}
