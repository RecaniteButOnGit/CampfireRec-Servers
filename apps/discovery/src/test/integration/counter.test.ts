import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { app } from '../../discovery.app'

const TOKEN = 'counter-test-token'

function request(name: 'CounterAdd' | 'CounterGet', token = TOKEN) {
	const command = `${name}8254TOKEN${JSON.stringify(token)}`
	return app.fetch(
		new Request(`https://discovery.example.com/sections/pagesource/${encodeURIComponent(command)}`),
		{ ...env, RRTOKEN: { get: async () => TOKEN } } as never,
		{} as never
	)
}

async function value(name: 'CounterAdd' | 'CounterGet') {
	const response = await request(name)
	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	const sections = (await response.json()) as Array<Record<string, unknown>>
	expect(sections).toHaveLength(1)
	const section = sections[0]!
	expect(section).toMatchObject({
		sectionType: 13,
		sectionSubType: 'CounterResponse',
		source: 'PageSource',
		sourceMetadata: section.id,
		displayMetadata: JSON.stringify({ DisplayTitle: section.id }),
	})
	return Number(section.id)
}

beforeAll(async () => {
	await env.DB.prepare(
		'CREATE TABLE IF NOT EXISTS cv2_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL CHECK (value >= 0))'
	).run()
	await env.DB.prepare('INSERT OR IGNORE INTO cv2_counter (id, value) VALUES (1, 0)').run()
})

beforeEach(async () => {
	await env.DB.prepare('UPDATE cv2_counter SET value = 0 WHERE id = 1').run()
})

describe('CV2 counter page sources', () => {
	it('starts at zero and persists additions across requests', async () => {
		expect(await value('CounterGet')).toBe(0)
		expect(await value('CounterAdd')).toBe(1)
		expect(await value('CounterGet')).toBe(1)
		expect(await value('CounterAdd')).toBe(2)
		expect(await value('CounterGet')).toBe(2)
	})

	it('requires the shared token for reads and writes', async () => {
		expect((await request('CounterAdd', 'wrong')).status).toBe(401)
		expect((await request('CounterGet', 'wrong')).status).toBe(401)
		const bare = await app.fetch(
			new Request('https://discovery.example.com/sections/pagesource/CounterAdd'),
			{ ...env, RRTOKEN: { get: async () => TOKEN } } as never,
			{} as never
		)
		expect(bare.status).toBe(401)
		expect(await value('CounterGet')).toBe(0)
	})

	it('returns every value once when adds arrive together', async () => {
		const responses = await Promise.all(Array.from({ length: 12 }, () => value('CounterAdd')))
		expect(responses.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1)
		)
		expect(await value('CounterGet')).toBe(12)
	})
})
