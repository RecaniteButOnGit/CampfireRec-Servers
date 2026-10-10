import { AGENT_LIMITS, estimateContext, estimateTokens, normalizeQuery } from './agent-config'
import { AgentFailure } from './saves'

import type { RecordData } from './protobuf'
import type { RoomWorkspace } from './workspace'

type Loaded = { handle: string; id: string; name: string; text: string }
export const SEARCH_TOOLS = new Set([
	'search_chips',
	'search_types',
	'search_definitions',
	'search_cv2_docs',
])
export const DEFINITION_TOOLS = new Set([
	'get_chip_definition',
	'get_type_definition',
	'get_event_definition',
	'get_definition',
	'get_chip_construction',
	'get_chip_variants',
	'get_registry_info',
])

/** Per-run retrieval state. The transcript is a working context, not the registry cache. */
export class AgentRetrieval {
	readonly usage = {
		modelCalls: 0,
		toolCalls: 0,
		registrySearches: 0,
		searchCacheHits: 0,
		definitionCacheHits: 0,
		modelInputTokens: 0,
		cachedInputTokens: 0,
		modelOutputTokens: 0,
		toolResultTokens: 0,
		currentContextTokens: 0,
		peakLiveContextTokens: 0,
		compileAttempts: 0,
		compactionCalls: 0,
	}
	private readonly searchCache = new Map<string, RecordData>()
	private readonly definitions = new Map<string, Loaded>()
	private readonly results = new Map<string, Loaded>()
	private readonly receipts = new Map<string, { turn: number; ttl: number; summary: string }>()
	private cachedCharacters = 0
	private pendingToolTokens = 0
	private lastCompileError: string | null = null
	private currentDiff: RecordData | null = null
	private pendingDiff: {
		handle: string
		version: number
		length: number
		ranges: Array<[number, number]>
	} | null = null
	private readonly started = Date.now()
	constructor(private readonly log: (message: string) => void) {}
	search(name: string, args: RecordData, load: () => RecordData): RecordData {
		const query = normalizeQuery(args.query)
		const key = JSON.stringify([
			name,
			query,
			args.category ?? 'all',
			args.offset ?? 0,
			args.limit ?? AGENT_LIMITS.searchResults,
		])
		const cached = this.searchCache.get(key)
		if (cached) {
			this.usage.searchCacheHits++
			this.log(`Registry search cache hit: ${JSON.stringify(query)}`)
			return {
				cached: true,
				query,
				total: cached.total ?? cached.globalDefinitions?.total,
				offset: args.offset ?? 0,
				nextOffset: cached.nextOffset ?? cached.globalDefinitions?.nextOffset ?? null,
				candidates: this.candidates(cached),
				note: 'Previously returned candidates. Use a specific get tool or refine the query.',
			}
		}
		if (this.usage.registrySearches >= AGENT_LIMITS.registrySearches)
			throw new AgentFailure(
				`Agent exceeded its ${AGENT_LIMITS.registrySearches} registry-search limit`
			)
		this.usage.registrySearches++
		const result = this.boundSearch({ ...load(), query })
		this.searchCache.set(key, result)
		this.log(
			`${name} ${JSON.stringify(query)}: Registry matches ${result.total ?? result.globalDefinitions?.total ?? 0}; returned ${this.candidates(result).length} candidates; estimated ${estimateTokens(JSON.stringify(result))} tokens`
		)
		return result
	}
	private candidates(result: RecordData): RecordData[] {
		return (
			result.definitions ??
			result.globalDefinitions?.definitions ??
			result.candidates ??
			[]
		).map((value: RecordData) => ({ id: value.id, name: value.name }))
	}
	private boundSearch(result: RecordData): RecordData {
		const bounded = structuredClone(result)
		const definitions = bounded.definitions ?? bounded.globalDefinitions?.definitions
		const originalDefinitions = result.definitions ?? result.globalDefinitions?.definitions ?? []
		const rawTokens = estimateTokens(JSON.stringify(result))
		if (rawTokens > AGENT_LIMITS.searchResultTokens) {
			bounded.compacted = true
			bounded.note = 'Payload bounded. Fetch an id, paginate with nextOffset, or refine the query.'
		}
		while (estimateTokens(JSON.stringify(bounded)) > AGENT_LIMITS.searchResultTokens) {
			if (definitions?.length > 1) definitions.pop()
			else if (bounded.documentation?.length) bounded.documentation.pop()
			else break
		}
		if (definitions && definitions.length < originalDefinitions.length) {
			const page = bounded.definitions ? bounded : bounded.globalDefinitions
			page.nextOffset = page.offset + definitions.length
		}
		if (estimateTokens(JSON.stringify(bounded)) > AGENT_LIMITS.searchResultTokens)
			throw new Error('Search preview exceeds its payload limit; refine the query')
		if (rawTokens > estimateTokens(JSON.stringify(bounded)))
			this.log(
				`Search produced estimated ${rawTokens} tokens; compacted to ${estimateTokens(JSON.stringify(bounded))}`
			)
		return bounded
	}
	definition(key: string, id: string, name: string, load: () => unknown) {
		const cached = this.definitions.get(key)
		if (cached) {
			this.usage.definitionCacheHits++
			this.log(`Definition cache hit: ${JSON.stringify(name)} [${id}]`)
			return this.reference(cached)
		}
		const output = load()
		const stored = this.store(output, id, name)
		this.definitions.set(key, stored)
		this.log(
			`Definition payload: ${estimateTokens(stored.text)} estimated tokens; ${stored.handle}`
		)
		return output
	}
	private store(output: unknown, id: string, name: string): Loaded {
		const text = JSON.stringify(output)
		if (this.cachedCharacters + text.length > AGENT_LIMITS.cachedResultCharacters)
			throw new Error('Run retrieval cache is full; request narrower graph sections or definitions')
		const stored = { handle: `result:${this.results.size + 1}`, id, name, text }
		this.results.set(stored.handle, stored)
		this.cachedCharacters += text.length
		return stored
	}
	private reference(stored: Loaded) {
		return {
			alreadyLoaded: true,
			definitionId: stored.id,
			name: stored.name,
			handle: stored.handle,
			totalCharacters: stored.text.length,
			readDetails:
				'Use read_cached_result(handle, offset, count) to retrieve authoritative content if it is no longer in active context.',
		}
	}
	read(handle: string, offset: number, count: number) {
		const stored = this.results.get(handle)
		if (!stored) throw new Error(`Unknown cached result ${handle}`)
		let pageCharacters = count
		const page = () => ({
			handle,
			definitionId: stored.id,
			offset,
			totalCharacters: stored.text.length,
			nextOffset: offset + pageCharacters < stored.text.length ? offset + pageCharacters : null,
			content: stored.text.slice(offset, offset + pageCharacters),
		})
		while (
			estimateTokens(JSON.stringify(page())) > AGENT_LIMITS.toolResultTokens * 0.9 &&
			pageCharacters > 1
		)
			pageCharacters = Math.max(1, Math.floor(pageCharacters * 0.8))
		return page()
	}
	list(offset: number, limit: number) {
		const loaded = [...this.definitions.values()]
		return {
			total: loaded.length,
			nextOffset: offset + limit < loaded.length ? offset + limit : null,
			definitions: loaded.slice(offset, offset + limit).map((stored) => this.reference(stored)),
		}
	}
	toolOutput(name: string, callId: string, output: unknown, turn: number): string {
		let text = JSON.stringify(output)
		const rawTokens = estimateTokens(text)
		let stored: Loaded | undefined
		let initialPageCharacters = 0
		if (rawTokens > AGENT_LIMITS.toolResultTokens) {
			stored =
				[...this.results.values()].find((value) => value.text === text) ??
				this.store(output, callId, name)
			// Keep every byte in run state. This is a page of the result, never silent truncation.
			let pageCharacters: number = AGENT_LIMITS.cachedResultPageCharacters
			const page = () =>
				JSON.stringify({
					paginated: true,
					...this.read(stored!.handle, 0, pageCharacters),
					note: 'Full result remains cached; read subsequent pages with read_cached_result. This page is a JSON text fragment.',
				})
			text = page()
			while (estimateTokens(text) > AGENT_LIMITS.toolResultTokens && pageCharacters > 1) {
				pageCharacters = Math.max(1, Math.floor(pageCharacters * 0.8))
				text = page()
			}
			initialPageCharacters = JSON.parse(text).content.length
			this.log(
				`${name} produced estimated ${rawTokens} tokens; paginated to ${estimateTokens(text)} tokens (${stored.handle})`
			)
		}
		const tokens = estimateTokens(text)
		this.usage.toolResultTokens += tokens
		this.pendingToolTokens += tokens
		if (name === 'get_diff') {
			this.pendingDiff = stored
				? {
						handle: stored.handle,
						version: this.currentDiff!.version,
						length: stored.text.length,
						ranges: [[0, initialPageCharacters]],
					}
				: null
		} else if (
			name === 'read_cached_result' &&
			this.pendingDiff != null &&
			this.pendingDiff?.handle === (output as RecordData).handle
		) {
			const page = output as RecordData
			this.pendingDiff.ranges.push([page.offset, page.offset + page.content.length])
		}
		if (SEARCH_TOOLS.has(name))
			this.receipts.set(callId, {
				turn,
				ttl: 2,
				summary: JSON.stringify({
					searchCompleted: true,
					query: (output as RecordData).query,
					total: (output as RecordData).total ?? (output as RecordData).globalDefinitions?.total,
					candidates: this.candidates(output as RecordData),
					note: 'Search previews discarded from active context. Selected definitions are kept in run state.',
				}),
			})
		else if (DEFINITION_TOOLS.has(name)) {
			stored ??= [...this.results.values()].find((value) => value.text === JSON.stringify(output))
			if (stored)
				this.receipts.set(callId, {
					turn,
					ttl: AGENT_LIMITS.definitionHistoryTurns,
					summary: JSON.stringify(this.reference(stored)),
				})
		}
		return text
	}
	prune(history: RecordData[], turn: number) {
		let changed = false
		const before = estimateContext(history)
		for (const item of history) {
			const receipt = this.receipts.get(item.call_id)
			if (receipt && turn >= receipt.turn + receipt.ttl) {
				const summary = JSON.parse(receipt.summary)
				if (summary.searchCompleted && summary.candidates) {
					const loaded = new Set([...this.definitions.values()].map((value) => value.id))
					summary.selectedDefinitions = summary.candidates.filter((value: RecordData) =>
						loaded.has(value.id)
					)
					delete summary.candidates
					summary.note =
						'Other candidates discarded; repeat the cached query or refine it if needed.'
					receipt.summary = JSON.stringify(summary)
				}
			}
			if (
				item.type === 'function_call_output' &&
				receipt &&
				turn >= receipt.turn + receipt.ttl &&
				item.output !== receipt.summary
			) {
				item.output = receipt.summary
				changed = true
			}
		}
		if (changed)
			this.log(
				`Retrieval context compacted: estimated ${before} -> ${estimateContext(history)} tokens`
			)
	}
	compiled(error: string | null) {
		this.lastCompileError = error
	}
	assertDiffReviewed(version: number) {
		if (!this.pendingDiff || this.pendingDiff.version !== version) return
		let covered = 0
		for (const [start, end] of [...this.pendingDiff.ranges].sort((a, b) => a[0] - b[0])) {
			if (start > covered) break
			covered = Math.max(covered, end)
		}
		if (covered < this.pendingDiff.length)
			throw new Error(
				`Diff review is incomplete. Use read_cached_result(${this.pendingDiff.handle}) at offset ${covered} before finishing.`
			)
	}
	diff(diff: RecordData, version: number) {
		const { patch: _patch, ...summary } = diff
		this.currentDiff = { version, ...summary }
	}
	snapshot(workspace: RoomWorkspace, prompt: string) {
		const graphs = [...workspace.files].map(([path, file]) => ({
			path,
			revision: file.revision,
			changed: file.text !== file.original,
		}))
		return {
			task: prompt,
			workspaceVersion: workspace.version,
			graphs: graphs.slice(0, 12),
			graphCount: graphs.length,
			changedGraphs: graphs.filter((graph) => graph.changed).slice(0, 12),
			selectedDefinitions: [...this.definitions.values()]
				.slice(-12)
				.map(({ handle, id, name }) => ({ handle, id, name })),
			loadedDefinitionCount: this.definitions.size,
			searchCacheEntries: this.searchCache.size,
			compileError: this.lastCompileError,
			currentDiff: this.currentDiff,
			pendingDiffReview: this.pendingDiff
				? { handle: this.pendingDiff.handle, version: this.pendingDiff.version }
				: null,
		}
	}
	context(tokens: number) {
		this.usage.currentContextTokens = tokens
		this.usage.peakLiveContextTokens = Math.max(tokens, this.usage.peakLiveContextTokens)
	}
	modelUsage(usage: RecordData | undefined) {
		const valid = (value: unknown) =>
			typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
		const input = valid(usage?.input_tokens),
			output = valid(usage?.output_tokens),
			cached = valid(usage?.input_tokens_details?.cached_tokens)
		this.usage.modelInputTokens += input
		this.usage.modelOutputTokens += output
		this.usage.cachedInputTokens += cached
		this.usage.peakLiveContextTokens = Math.max(input, this.usage.peakLiveContextTokens)
		this.log(
			`Input: ${input}; Output: ${output}; Cached input: ${cached}; Tool payload since previous call (estimated): ${this.pendingToolTokens}; Current context (estimated): ${this.usage.currentContextTokens}; Generated output cumulative: ${this.usage.modelOutputTokens}`
		)
		this.pendingToolTokens = 0
		if (this.usage.modelOutputTokens > AGENT_LIMITS.generatedOutputTokens)
			throw new AgentFailure(
				`Agent exceeded its ${AGENT_LIMITS.generatedOutputTokens} generated-output-token limit`
			)
	}
	summary() {
		this.log(
			`Usage summary: ${JSON.stringify({ ...this.usage, toolResultTokensEstimated: true, currentContextTokensEstimated: true, durationMs: Date.now() - this.started })}`
		)
	}
}
