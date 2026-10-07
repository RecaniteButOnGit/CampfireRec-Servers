/** Application guardrails, intentionally well below the model's context window. */
export const AGENT_LIMITS = Object.freeze({
	modelCalls: 30,
	toolCalls: 60,
	registrySearches: 15,
	compileRepairs: 5,
	generatedOutputTokens: 60000,
	maxOutputTokensPerCall: 12000,
	liveContextTokens: 48000,
	clientCompactionTokens: 28000,
	serverCompactionTokens: 16000,
	searchResults: 8,
	maxSearchResults: 10,
	searchResultTokens: 1400,
	toolResultTokens: 6000,
	cachedResultPageCharacters: 6000,
	cachedResultCharacters: 4000000,
	definitionHistoryTurns: 4,
	lookupSuggestions: 5,
	toolArgumentCharacters: 250000,
	requestTimeoutMs: 120000,
})

/** Conservative text estimate only. API-reported usage is logged separately. */
export const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 3)
export const normalizeQuery = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ')

/** Ciphertext size differs from its rendered token count. Keep opaque state without estimating it. */
export const estimateContext = (items: unknown) =>
	estimateTokens(
		JSON.stringify(items, (key, value) =>
			key === 'encrypted_content' ? '[opaque continuity state]' : value
		)
	)
