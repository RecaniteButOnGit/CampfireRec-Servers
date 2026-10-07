import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent } from '../../discovery/src/cv2-agent/agent'
import { AGENT_LIMITS, estimateTokens } from '../../discovery/src/cv2-agent/agent-config'
import { guid, roomType } from '../../discovery/src/cv2-agent/protobuf'
import { getCv2DefinitionRegistry } from '../../discovery/src/cv2-agent/registry'
import { AgentRetrieval } from '../../discovery/src/cv2-agent/retrieval'
import { RoomDocument } from '../../discovery/src/cv2-agent/room'
import { RoomWorkspace } from '../../discovery/src/cv2-agent/workspace'

import type { RecordData } from '../../discovery/src/cv2-agent/protobuf'

const registry = getCv2DefinitionRegistry()
const workspace = () =>
	new RoomWorkspace(
		new RoomDocument(
			roomType
				.encode(
					roomType.fromObject({
						circuit_v2_data: { root: { graph_id: guid('11'.repeat(16)) } },
					})
				)
				.finish()
		)
	)
type Step = readonly [string, RecordData]
const abort: Step = ['abort', { reason: 'Test complete' }]
function scripted(
	steps: readonly Step[],
	extra: (call: number) => RecordData[] = () => [],
	outputTokens = 400
) {
	const requests: RecordData[] = [],
		logs: string[] = []
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
		const body = JSON.parse(init!.body as string)
		requests.push(body)
		const call = requests.length,
			[name, args] = steps[call - 1]!
		return Response.json({
			status: 'completed',
			usage: {
				input_tokens: 32000,
				output_tokens: outputTokens,
				total_tokens: 32000 + outputTokens,
				input_tokens_details: { cached_tokens: 24000 },
			},
			output: [
				...extra(call),
				{ type: 'function_call', call_id: `call_${call}`, name, arguments: JSON.stringify(args) },
			],
		})
	})
	return {
		requests,
		logs,
		run: (ws = workspace()) =>
			runAgent(
				ws,
				'Build double-jump-style player logic',
				'mock-key',
				(message) => logs.push(message),
				async () => {},
				Date.now() + 100000
			),
	}
}
const lastResult = (request: RecordData) => JSON.parse(request.input.at(-1).output)
afterEach(() => vi.restoreAllMocks())

describe('CV2 compact retrieval and context guardrails', () => {
	it('bounds broad registry/document previews and ranks direct capabilities ahead of incidental metadata', () => {
		for (const query of [
			'*',
			'player',
			'player velocity',
			'grounded',
			'hand position',
			'jump',
			'update',
		]) {
			const result = registry.searchChips(query)
			expect(result.definitions.length).toBeLessThanOrEqual(AGENT_LIMITS.searchResults)
			expect(estimateTokens(JSON.stringify(result))).toBeLessThan(AGENT_LIMITS.searchResultTokens)
			expect(JSON.stringify(result)).not.toMatch(
				/NodeDescs|configurationFields|wireDefault|provenance/
			)
		}
		const velocity = registry.searchChips('player velocity').definitions
		expect(velocity.slice(0, 3).every((value) => /player.*velocity/i.test(value.name))).toBe(true)
		expect(registry.searchChips('Player Get Is Grounded').definitions[0].name).toBe(
			'Player Get Is Grounded'
		)
		const ws = workspace(),
			docs = ws.docs('chip')
		expect(
			docs.documentation.length + docs.globalDefinitions.definitions.length
		).toBeLessThanOrEqual(8)
		expect(estimateTokens(JSON.stringify(docs))).toBeLessThan(AGENT_LIMITS.searchResultTokens)
		expect(ws.readDoc('/room/docs/language.md', 1, 10).text).toContain('CV2 IR')
	})
	it('normalizes and caches repeated searches without reloading or reinjecting their previews', async () => {
		const search = vi.spyOn(registry, 'searchChips')
		const model = scripted([
			['search_chips', { query: 'player velocity', offset: null, limit: null }],
			['search_chips', { query: 'Player Velocity', offset: null, limit: null }],
			['search_chips', { query: ' player   velocity ', offset: null, limit: null }],
			abort,
		])
		await expect(model.run()).rejects.toThrow('Test complete')
		expect(search).toHaveBeenCalledTimes(1)
		expect(lastResult(model.requests[1]).definitions.length).toBeLessThanOrEqual(8)
		expect(lastResult(model.requests[2]).cached).toBe(true)
		expect(lastResult(model.requests[3]).cached).toBe(true)
		expect(JSON.stringify(model.requests[3].input)).not.toContain('"definitions"')
		expect(model.logs.filter((line) => line.includes('Registry search cache hit'))).toHaveLength(2)
	})
	it('deduplicates definitions across aliases and get tools, and can reload authoritative cached content', async () => {
		const ws = workspace(),
			get = vi.spyOn(ws, 'chipDefinition'),
			chip = registry.getChip('Player Get Is Grounded')!
		const model = scripted([
			['get_chip_definition', { type: chip.name }],
			['get_chip_definition', { type: chip.runtimeGuid }],
			['get_definition', { id: chip.id }],
			['read_cached_result', { handle: 'result:1', offset: 0, count: 6000 }],
			abort,
		])
		await expect(model.run(ws)).rejects.toThrow('Test complete')
		expect(get).toHaveBeenCalledTimes(1)
		expect(lastResult(model.requests[2])).toMatchObject({
			alreadyLoaded: true,
			definitionId: chip.id,
			handle: 'result:1',
		})
		expect(lastResult(model.requests[3]).alreadyLoaded).toBe(true)
		expect(lastResult(model.requests[4]).content).toContain(chip.typeId)
		expect(
			model.requests[4].input.find(
				(item: RecordData) => item.call_id === 'call_1' && item.type === 'function_call_output'
			).output
		).not.toContain('NodeDescs')
	})
	it('provides compact nearest candidates for misspelled chips/events/types without selecting one automatically', async () => {
		const model = scripted([
			['get_event_definition', { event: 'Update 30 Hz' }],
			['get_chip_definition', { type: 'Player Get Is Gronded' }],
			['get_type_definition', { type: 'Vectr3' }],
			abort,
		])
		await expect(model.run()).rejects.toThrow('Test complete')
		for (const request of model.requests.slice(1)) {
			const result = lastResult(request)
			expect(result.error).toBeDefined()
			expect(result.closestMatches.length).toBeGreaterThan(0)
			expect(result.closestMatches.length).toBeLessThanOrEqual(5)
			expect(estimateTokens(JSON.stringify(result))).toBeLessThan(AGENT_LIMITS.searchResultTokens)
		}
		expect(lastResult(model.requests[2]).closestMatches[0].name).toBe('Player Get Is Grounded')
	})
	it('pages oversized results without losing bytes or injecting large Unicode payloads', () => {
		const state = new AgentRetrieval(() => {}),
			original = { id: 'large', content: '資料'.repeat(12000) }
		const result = JSON.parse(state.toolOutput('get_definition', 'call_big', original, 1))
		expect(result.paginated).toBe(true)
		expect(estimateTokens(JSON.stringify(result))).toBeLessThanOrEqual(
			AGENT_LIMITS.toolResultTokens
		)
		let text = result.content,
			offset = result.nextOffset
		while (offset !== null) {
			const page = state.read(result.handle, offset, 6000)
			text += page.content
			offset = page.nextOffset
		}
		expect(JSON.parse(text)).toEqual(original)
	})
	it('preserves the complete diff-review requirement when the diff is paginated', () => {
		const state = new AgentRetrieval(() => {}),
			diff = { files: ['graph'], chipsChanged: 30, patch: 'edit\n'.repeat(7000) }
		state.diff(diff, 3)
		const first = JSON.parse(state.toolOutput('get_diff', 'call_diff', diff, 1))
		expect(first.paginated).toBe(true)
		expect(() => state.assertDiffReviewed(3)).toThrow('Diff review is incomplete')
		// Reading a final page alone cannot cover missing middle pages.
		const last = state.read(first.handle, first.totalCharacters - 10, 10)
		state.toolOutput('read_cached_result', 'call_last', last, 2)
		expect(() => state.assertDiffReviewed(3)).toThrow('Diff review is incomplete')
		let offset = first.nextOffset
		while (offset !== null) {
			const page = state.read(first.handle, offset, 6000)
			state.toolOutput('read_cached_result', `call_${offset}`, page, 3)
			offset = page.nextOffset
		}
		expect(() => state.assertDiffReviewed(3)).not.toThrow()
	})
	it('keeps a long search run small and does not budget repeated input as generated work', async () => {
		const model = scripted([
			['search_chips', { query: '*', offset: 0, limit: 8 }],
			...Array.from({ length: 13 }, (): Step => [
				'search_chips',
				{ query: '*', offset: 0, limit: 8 },
			]),
			abort,
		])
		await expect(model.run()).rejects.toThrow('Test complete')
		const contexts = model.requests.map((request) => estimateTokens(JSON.stringify(request.input)))
		expect(contexts.at(-1)! - contexts[2]).toBeLessThan(2000)
		expect(model.requests).toHaveLength(15)
		const usage = JSON.parse(
			model.logs.find((line) => line.startsWith('Usage summary:'))!.slice('Usage summary: '.length)
		)
		expect(usage.modelInputTokens).toBe(480000)
		expect(usage.cachedInputTokens).toBe(360000)
		expect(usage.modelOutputTokens).toBe(6000)
		expect(usage.registrySearches).toBe(1)
		expect(usage.searchCacheHits).toBe(13)
	})
	it('continues room edits and repairs after server compaction while retaining selected definitions and compiler state', async () => {
		const ws = workspace(),
			graph = [...ws.files.keys()][0]!
		const chip = (
			type: string,
			revision: number,
			label: string,
			bindings: RecordData[] = []
		): Step => [
			'create_chip',
			{
				graph,
				revision,
				type,
				label,
				bindings,
				name: null,
				variable: null,
				configuration: null,
			},
		]
		const wire =
			'\n  wire "new:link" = {"src_node_id":{"value":"new:player"},"dst_node_id":{"value":"new:hand"},"src_port_id":99}\n' +
			'  wire "new:grounded" = {"src_node_id":{"value":"new:player"},"dst_node_id":{"value":"new:grounded"}}\n' +
			'  wire "new:condition" = {"src_node_id":{"value":"new:grounded"},"dst_node_id":{"value":"new:branch"},"dst_port_id":1}\n' +
			'  wire "new:exec" = {"src_node_id":{"value":"new:branch"},"dst_node_id":{"value":"new:velocity"}}\n' +
			'  wire "new:target" = {"src_node_id":{"value":"new:player"},"dst_node_id":{"value":"new:velocity"},"dst_port_id":1}\n' +
			'  wire "new:direction" = {"src_node_id":{"value":"new:hand"},"dst_node_id":{"value":"new:velocity"},"dst_port_id":3}\n}\n'
		const model = scripted(
			[
				['list_graphs', { offset: 0, limit: 5 }],
				['search_chips', { query: 'hand position', offset: 0, limit: 5 }],
				['get_chip_definition', { type: 'Player Right Hand Position' }],
				['get_chip_construction', { type: 'Player Right Hand Position' }],
				['get_chip_definition', { type: 'Player Get Is Grounded' }],
				['get_chip_definition', { type: '75ca5e1b7e0eff4a8adcc5e043cac29e' }],
				chip('Get Local Player', 0, 'player'),
				chip('Player Right Hand Position', 1, 'hand'),
				chip('Player Get Is Grounded', 2, 'grounded'),
				chip('If', 3, 'branch'),
				chip('75ca5e1b7e0eff4a8adcc5e043cac29e', 4, 'velocity', [{ name: 'T', type: 'Player' }]),
				['read_graph', { graph, start: 1, count: 200 }],
				['apply_patch', { graph, revision: 5, edits: [{ old: '\n}\n', new: wire }] }],
				['validate_graph', { graph }],
				[
					'apply_patch',
					{ graph, revision: 6, edits: [{ old: '"src_port_id":99', new: '"src_port_id":0' }] },
				],
				['validate_graph', { graph }],
				['validate_room', {}],
				['get_diff', {}],
				['finish', {}],
			],
			(call) =>
				call === 15 ? [{ type: 'compaction', encrypted_content: 'opaque-state', id: 'cmp_1' }] : []
		)
		const result = await model.run(ws)
		expect(result.diff).toMatchObject({ chipsCreated: 5, connectionsAdded: 6 })
		expect(model.requests[15].input[0].type).toBe('compaction')
		expect(model.requests[14].instructions).toContain('does not exist')
		expect(model.requests[15].instructions).toContain('Player Right Hand Position')
		expect(model.requests.at(-1)!.instructions).toContain('connectionsAdded')
		expect(ws.files.get(graph)!.revision).toBe(7)
		expect(model.logs.some((line) => line.includes('Usage summary'))).toBe(true)
	})
	it('enforces independent generated-work and search limits and logs failures without hidden reasoning', async () => {
		const heavy = scripted(
			Array.from({ length: 10 }, (): Step => ['list_graphs', { offset: 0, limit: 1 }]),
			() => [{ type: 'reasoning', encrypted_content: 'secret-reasoning' }],
			12000
		)
		await expect(heavy.run()).rejects.toThrow('generated-output-token limit')
		expect(heavy.logs.join('\n')).not.toContain('secret-reasoning')
		expect(heavy.logs.at(-1)).toContain('Usage summary')
		vi.restoreAllMocks()
		const many = scripted(
			Array.from({ length: 16 }, (_, offset): Step => [
				'search_chips',
				{ query: '*', offset, limit: 1 },
			])
		)
		await expect(many.run()).rejects.toThrow('registry-search limit')
	})
	it('uses the complete canonical standalone compaction window and retains cached definitions', async () => {
		const requests: RecordData[] = [],
			logs: string[] = []
		const canonical = [
			{ role: 'user', content: 'Original task' },
			{ type: 'compaction', encrypted_content: 'opaque-canonical', id: 'cmp_1' },
			{ role: 'assistant', content: 'Retained decision: inspect registry limits' },
		]
		let normalCalls = 0
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			const body = JSON.parse(init!.body as string)
			requests.push({ ...body, url: String(url) })
			if (String(url).endsWith('/compact'))
				return Response.json({
					output: canonical,
					usage: { input_tokens: 30000, output_tokens: 100 },
				})
			normalCalls++
			const [name, args] =
				normalCalls === 1
					? ['get_registry_info', {}]
					: normalCalls === 2
						? ['read_cached_result', { handle: 'result:1', offset: 0, count: 5000 }]
						: abort
			return Response.json({
				status: 'completed',
				usage: { input_tokens: 2000, output_tokens: 100 },
				output: [
					...(normalCalls === 1
						? [
								{
									type: 'message',
									role: 'assistant',
									content: [{ type: 'output_text', text: 'Decision. '.repeat(9000) }],
								},
							]
						: []),
					{
						type: 'function_call',
						call_id: `call_${normalCalls}`,
						name,
						arguments: JSON.stringify(args),
					},
				],
			})
		})
		await expect(
			runAgent(
				workspace(),
				'Original task',
				'mock',
				(message) => logs.push(message),
				async () => {},
				Date.now() + 100000
			)
		).rejects.toThrow('Test complete')
		expect(requests[1].url).toContain('/responses/compact')
		expect(requests[2].input).toEqual(canonical)
		expect(requests[2].instructions).toContain('result:1')
		expect(lastResult(requests[3]).content).toContain('publishedChipCount')
		expect(logs.some((line) => line.startsWith('Context compacted'))).toBe(true)
		expect(logs.join('\n')).not.toContain('opaque-canonical')
	})
	it('enforces model-call and live-input limits independently of the generated-output limit', async () => {
		const calls = scripted(
			Array.from({ length: AGENT_LIMITS.modelCalls }, (): Step => [
				'list_loaded_definitions',
				{ offset: 0, limit: 1 },
			])
		)
		await expect(calls.run()).rejects.toThrow('30 model-call limit')
		expect(calls.requests).toHaveLength(30)
		vi.restoreAllMocks()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({
				status: 'completed',
				usage: { input_tokens: 48001, output_tokens: 100 },
				output: [
					{
						type: 'function_call',
						call_id: 'call_1',
						name: 'list_graphs',
						arguments: '{"offset":0,"limit":1}',
					},
				],
			})
		)
		await expect(
			runAgent(
				workspace(),
				'Test',
				'key',
				() => {},
				async () => {},
				Date.now() + 100000
			)
		).rejects.toThrow('live input exceeded')
	})
})
