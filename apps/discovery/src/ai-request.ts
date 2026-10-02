import type { App } from './context'

const PREFIX = 'AIRequest['
const TOKEN_MARKER = '8254TOKEN'
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const FIELDS = new Set(['Prompt', 'Model', 'SystemPrompt', 'Reasoning'])

type AIRequest = {
	prompt: string
	model: string
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

export function parseFields(body: string, allowedFields: ReadonlySet<string> = FIELDS): Record<string, string> | null {
	const fields: Record<string, string> = {}
	let index = 0
	while (index < body.length) {
		while (/\s/.test(body[index] ?? '')) index++
		const start = index
		while (/[A-Za-z]/.test(body[index] ?? '')) index++
		const name = body.slice(start, index)
		if (!allowedFields.has(name) || Object.hasOwn(fields, name)) return null
		while (/\s/.test(body[index] ?? '')) index++
		if (body[index++] !== ':') return null
		while (/\s/.test(body[index] ?? '')) index++
		if (body[index++] !== '"') return null
		const valueStart = index
		let valueEnd = -1
		let nextField = body.length
		let parsedValue: string | undefined
		let rawBoundary: { end: number; next: number } | undefined
		while (index < body.length) {
			const char = body[index++]
			if (char !== '"') continue
			let afterQuote = index
			while (/\s/.test(body[afterQuote] ?? '')) afterQuote++
			let next = body.length
			if (afterQuote !== body.length) {
				if (body[afterQuote] !== ',') continue
				let nextName = afterQuote + 1
				while (/\s/.test(body[nextName] ?? '')) nextName++
				const nextStart = nextName
				while (/[A-Za-z]/.test(body[nextName] ?? '')) nextName++
				if (nextName === nextStart) continue
				while (/\s/.test(body[nextName] ?? '')) nextName++
				if (body[nextName] !== ':') continue
				next = afterQuote + 1
			}
			try {
				const parsed: unknown = JSON.parse(body.slice(valueStart - 1, index))
				if (typeof parsed !== 'string') return null
				parsedValue = parsed
				valueEnd = index - 1
				nextField = next
				break
			} catch {
				rawBoundary ??= { end: index - 1, next }
			}
		}
		if (valueEnd === -1 && rawBoundary) {
			valueEnd = rawBoundary.end
			nextField = rawBoundary.next
		}
		if (valueEnd === -1) return null
		if (parsedValue === undefined) {
			// CV2 strings often contain literal newlines, quotes or backslashes rather than
			// JSON escapes. Keep them as text when the field delimiters are unambiguous.
			fields[name] = body.slice(valueStart, valueEnd)
		} else fields[name] = parsedValue
		index = nextField
	}
	return fields
}

export function parseTokenSuffix(suffix: string): string | null {
	if (!suffix.startsWith(TOKEN_MARKER)) return null
	let token: unknown
	try { token = JSON.parse(suffix.slice(TOKEN_MARKER.length)) } catch { return null }
	return typeof token === 'string' && token ? token : null
}

export function parseEnvelope(value: string, prefix = PREFIX): { body: string; token: string } | null {
	if (!value.startsWith(prefix)) return null
	// The token marker identifies the end of the request even when a raw quote or
	// bracket in the prompt would confuse a quote-tracking scan.
	const marker = `]${TOKEN_MARKER}`
	for (let closingBracket = value.indexOf(marker, prefix.length); closingBracket !== -1;
		closingBracket = value.indexOf(marker, closingBracket + 1)) {
		const token = parseTokenSuffix(value.slice(closingBracket + 1))
		if (token) return { body: value.slice(prefix.length, closingBracket), token }
	}
	return null
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
	return { prompt, model, reasoning, systemPrompt, token: envelope.token }
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
	const configured = typeof env.RRTOKEN === 'string' ? env.RRTOKEN : await env.RRTOKEN?.get()
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
