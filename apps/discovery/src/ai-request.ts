import type { App } from './context'

const PREFIX = 'AIRequest['
const TOKEN_MARKER = '8254TOKEN'
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const FIELDS = new Set(['Prompt', 'Model', 'Temp', 'SystemPrompt', 'Reasoning'])

type AIRequest = {
	prompt: string
	model: string
	temperature?: number
	systemPrompt?: string
	reasoning: string
	token: string
}

/** The CV2 chip expects a list of discovery sections, so carry text in fields it can read. */
function sectionList(text: string) {
	return [{
		id: text,
		sectionType: 13,
		sectionSubType: 'AIResponse',
		source: 'PageSource',
		sourceMetadata: text,
		displayMetadata: JSON.stringify({ DisplayTitle: text }),
	}]
}

function parseFields(body: string): Record<string, string> | null {
	const fields: Record<string, string> = {}
	let index = 0
	while (index < body.length) {
		while (/\s/.test(body[index] ?? '')) index++
		const start = index
		while (/[A-Za-z]/.test(body[index] ?? '')) index++
		const name = body.slice(start, index)
		if (!FIELDS.has(name) || Object.hasOwn(fields, name)) return null
		while (/\s/.test(body[index] ?? '')) index++
		if (body[index++] !== ':') return null
		while (/\s/.test(body[index] ?? '')) index++
		const valueStart = index
		if (body[index++] !== '"') return null
		let escaped = false
		let closed = false
		while (index < body.length) {
			const char = body[index++]
			if (escaped) escaped = false
			else if (char === '\\') escaped = true
			else if (char === '"') { closed = true; break }
		}
		if (!closed) return null
		try {
			const value: unknown = JSON.parse(body.slice(valueStart, index))
			if (typeof value !== 'string') return null
			fields[name] = value
		} catch { return null }
		while (/\s/.test(body[index] ?? '')) index++
		if (index === body.length) break
		if (body[index++] !== ',') return null
		while (/\s/.test(body[index] ?? '')) index++
		if (index === body.length) return null
	}
	return fields
}

export function parseTokenSuffix(suffix: string): string | null {
	if (!suffix.startsWith(TOKEN_MARKER)) return null
	let token: unknown
	try { token = JSON.parse(suffix.slice(TOKEN_MARKER.length)) } catch { return null }
	return typeof token === 'string' && token ? token : null
}

function parseEnvelope(value: string): { body: string; token: string } | null {
	if (!value.startsWith(PREFIX)) return null
	let quoted = false
	let escaped = false
	let closingBracket = -1
	for (let index = PREFIX.length; index < value.length; index++) {
		const char = value[index]
		if (escaped) escaped = false
		else if (quoted && char === '\\') escaped = true
		else if (char === '"') quoted = !quoted
		else if (!quoted && char === ']') { closingBracket = index; break }
	}
	if (closingBracket === -1) return null
	const token = parseTokenSuffix(value.slice(closingBracket + 1))
	if (!token) return null
	return { body: value.slice(PREFIX.length, closingBracket), token }
}

export function parseAIRequest(value: string): AIRequest | null {
	const envelope = parseEnvelope(value)
	if (!envelope) return null
	const fields = parseFields(envelope.body)
	if (!fields) return null
	const prompt = fields.Prompt
	const systemPrompt = fields.SystemPrompt
	const model = fields.Model ?? 'gpt-6-luna'
	const reasoning = fields.Reasoning ?? 'none'
	if (!prompt?.trim() || !/^[A-Za-z0-9_.-]+$/.test(model) || !REASONING_EFFORTS.has(reasoning)) return null
	const temperature = fields.Temp === undefined ? undefined : Number(fields.Temp)
	if (temperature !== undefined && (!fields.Temp || !Number.isFinite(temperature) || temperature < 0 || temperature > 2 || reasoning !== 'none')) return null
	return { prompt, model, reasoning, temperature, systemPrompt, token: envelope.token }
}

async function tokenMatches(provided: string, configured: string): Promise<boolean> {
	const encoder = new TextEncoder()
	const [providedHash, configuredHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(provided)),
		crypto.subtle.digest('SHA-256', encoder.encode(configured)),
	])
	const left = new Uint8Array(providedHash)
	const right = new Uint8Array(configuredHash)
	let difference = 0
	for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
	return difference === 0
}

export async function authorizedToken(provided: string | null, env: App['Bindings']): Promise<boolean> {
	if (!provided) return false
	const configured = await env.RRTOKEN?.get()
	return Boolean(configured && await tokenMatches(provided, configured))
}

function outputText(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object' || !('output' in payload) || !Array.isArray(payload.output)) return null
	const parts: string[] = []
	for (const item of payload.output) {
		if (!item || typeof item !== 'object' || !('content' in item) || !Array.isArray(item.content)) continue
		for (const content of item.content) {
			if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text)
		}
	}
	return parts.join('\n').trim() || null
}

export async function handleAIRequest(value: string, env: App['Bindings']) {
	const envelope = parseEnvelope(value)
	if (!envelope || !(await authorizedToken(envelope.token, env))) return null
	const request = parseAIRequest(value)
	if (!request) return sectionList('AIError:InvalidRequest')
	const key = (await env.OPENAIKEY?.get())?.trim()
	if (!key) return sectionList('AIError:NotConfigured')
	try {
		const response = await fetch(OPENAI_RESPONSES_URL, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: request.model,
				input: request.prompt,
				instructions: request.systemPrompt,
				reasoning: { effort: request.reasoning },
				temperature: request.temperature,
				store: false,
			}),
			signal: AbortSignal.timeout(15_000),
		})
		if (!response.ok) return sectionList(`AIError:OpenAI${response.status}`)
		const text = outputText(await response.json())
		return sectionList(text ?? 'AIError:EmptyResponse')
	} catch {
		return sectionList('AIError:UpstreamUnavailable')
	}
}
