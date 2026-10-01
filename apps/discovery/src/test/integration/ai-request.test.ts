import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseAIRequest } from '../../ai-request'
import app from '../../discovery.app'

const TOKEN = 'rr-test-token'
const KEY = 'sk-test-openai'
const FIELDS = 'Prompt:"Hello",Model:"gpt-6-luna",SystemPrompt:"You are an AI created for Rec Room",Reasoning:"none"'

function command(fields = FIELDS, token = TOKEN) {
	return `AIRequest[${fields}]8254TOKEN${JSON.stringify(token)}`
}

function request(value: string, options: { token?: string; key?: string; encoded?: boolean } = {}) {
	return app.fetch(
		new Request(`https://discovery.example.com/sections/pagesource/${options.encoded === false ? value : encodeURIComponent(value)}`),
		{
			...env,
			NAME: 'discovery',
			ENVIRONMENT: 'VITEST',
			SENTRY_RELEASE: 'test',
			OPENAIKEY: options.key === undefined ? { get: async () => KEY } : options.key ? { get: async () => options.key } : undefined,
			RRTOKEN: options.token === undefined ? { get: async () => TOKEN } : options.token ? { get: async () => options.token } : undefined,
		} as never,
		{} as never
	)
}

afterEach(() => vi.restoreAllMocks())

describe('CV2 AIRequest page source', () => {
	it('sends the requested prompt and options to Responses and returns text as a section', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
			output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello back' }] }],
		}))
		const res = await request(command())
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([{
			id: 'Hello back',
			sectionType: 13,
			sectionSubType: 'AIResponse',
			source: 'PageSource',
			sourceMetadata: 'Hello back',
			displayMetadata: '{"DisplayTitle":"Hello back"}',
		}])
		expect(outbound).toHaveBeenCalledTimes(1)
		const [url, init] = outbound.mock.calls[0]
		expect(url).toBe('https://api.openai.com/v1/responses')
		expect(init?.method).toBe('POST')
		expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}` })
		expect(JSON.parse(init?.body as string)).toEqual({
			model: 'gpt-6-luna',
			input: 'Hello',
			instructions: 'You are an AI created for Rec Room',
			reasoning: { effort: 'none' },
			store: false,
		})
		expect(JSON.stringify(init)).not.toContain(TOKEN)
	})

	it('keeps commas and brackets inside quoted prompt values', () => {
		expect(parseAIRequest(command('Prompt:"Hello, [Rec Room]"'))).toMatchObject({
			prompt: 'Hello, [Rec Room]', token: TOKEN,
		})
	})

	it('passes URL-encoded special characters and JSON escapes through to OpenAI', async () => {
		const prompt = 'What does "C:\\Games\\Rec Room" mean? #tag & 50% + / [a,b] 😀\nNext line'
		const systemPrompt = 'Reply with "yes" and a backslash: \\'
		const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
			output: [{ type: 'message', content: [{ type: 'output_text', text: 'Accepted' }] }],
		}))
		const res = await request(command(`Prompt:${JSON.stringify(prompt)},SystemPrompt:${JSON.stringify(systemPrompt)}`))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'Accepted' }])
		const [, init] = outbound.mock.calls[0]
		expect(JSON.parse(init?.body as string)).toMatchObject({ input: prompt, instructions: systemPrompt })
	})

	it('recovers an unencoded question mark that moved the token into the URL query', async () => {
		const systemPrompt = 'Answer? Use "quotes" & 100%$ + C:\\Games [x].'
		const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
			output: [{ type: 'message', content: [{ type: 'output_text', text: 'Accepted' }] }],
		}))
		const res = await request(command(`Prompt:"What? Explain it",SystemPrompt:"${systemPrompt}",Reasoning:"none"`), { encoded: false })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'Accepted' }])
		const [, init] = outbound.mock.calls[0]
		expect(JSON.parse(init?.body as string).input).toBe('What? Explain it')
		expect(JSON.parse(init?.body as string).instructions).toBe(systemPrompt)
	})

	it('accepts literal CV2 quotes, backslashes, newlines and brackets in a field', async () => {
		const prompt = 'What is "C:\\Games"? #tag [a,b]\nSecond line'
		const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
			output: [{ type: 'message', content: [{ type: 'output_text', text: 'Accepted' }] }],
		}))
		const res = await request(command(`Prompt:"${prompt}",Reasoning:"none"`))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'Accepted' }])
		const [, init] = outbound.mock.calls[0]
		expect(JSON.parse(init?.body as string).input).toBe(prompt)
	})

	it('keeps the token boundary when the prompt contains its marker', () => {
		expect(parseAIRequest(command('Prompt:"Please explain ]8254TOKEN in a prompt"'))).toMatchObject({
			prompt: 'Please explain ]8254TOKEN in a prompt', token: TOKEN,
		})
	})

	it('preserves a literal trailing backslash and escaped delimiter-like text', () => {
		expect(parseAIRequest(command('Prompt:"C:\\",Reasoning:"none"'))?.prompt).toBe('C:\\')
		const prompt = 'Explain ",Reasoning:" as literal text'
		expect(parseAIRequest(command(`Prompt:${JSON.stringify(prompt)},Reasoning:"none"`))?.prompt).toBe(prompt)
	})

	it('rejects missing or wrong tokens before contacting OpenAI', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch')
		for (const value of [command(FIELDS, 'wrong'), `AIRequest[${FIELDS}]`]) {
			const res = await request(value)
			expect(res.status).toBe(401)
			expect(await res.text()).toBe('')
		}
		const unconfigured = await request(command(), { token: '' })
		expect(unconfigured.status).toBe(401)
		expect(outbound).not.toHaveBeenCalled()
	})

	it('accepts low reasoning without sending temperature upstream', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
			output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello back' }] }],
		}))
		const res = await request(command('Prompt:"Hello",Reasoning:"low"'))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'Hello back' }])
		const [, init] = outbound.mock.calls[0]
		expect(JSON.parse(init?.body as string)).toMatchObject({ reasoning: { effort: 'low' } })
		expect(JSON.parse(init?.body as string)).not.toHaveProperty('temperature')
	})

	it('returns a section error for invalid options with a valid token', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch')
		const res = await request(command('Prompt:"Hello",Reasoning:"1"'))
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'AIError:InvalidRequest' }])
		expect(outbound).not.toHaveBeenCalled()
		const oldFormat = await request(command('Prompt:"Hello",Reasoning:"low",Temp:"0.3"'))
		expect(await oldFormat.json()).toMatchObject([{ id: 'AIError:InvalidRequest' }])
		expect(outbound).not.toHaveBeenCalled()
	})

	it('returns a section error when the OpenAI key is not configured', async () => {
		const outbound = vi.spyOn(globalThis, 'fetch')
		const res = await request(command(), { key: '' })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'AIError:NotConfigured' }])
		expect(outbound).not.toHaveBeenCalled()
	})

	it('returns only the upstream status when OpenAI rejects a request', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
			JSON.stringify({ error: { message: `${KEY} must not reach the CV2 chip` } }),
			{ status: 400 }
		))
		const res = await request(command())
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject([{ id: 'AIError:OpenAI400' }])
	})
})
