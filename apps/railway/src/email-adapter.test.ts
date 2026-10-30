import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResendEmail } from './email-adapter'

afterEach(() => vi.unstubAllGlobals())

describe('Railway email adapter', () => {
	it('sends the Workers email message through Resend, preserving its sender name', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(null, { status: 202 })
		)
		vi.stubGlobal('fetch', fetchMock)

		await new ResendEmail('re_test_key').send({
			from: { email: 'no-reply@example.test', name: 'Campfire' },
			to: 'player@example.test',
			subject: 'Your recovery code',
			text: '123456',
			html: '<p>123456</p>',
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://api.resend.com/emails')
		expect(init?.headers).toMatchObject({ authorization: 'Bearer re_test_key' })
		expect(JSON.parse(String(init?.body))).toMatchObject({
			from: 'Campfire <no-reply@example.test>',
			to: ['player@example.test'],
			subject: 'Your recovery code',
			text: '123456',
			html: '<p>123456</p>',
		})
	})

	it('surfaces provider failures and refuses to pretend email was sent without a key', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 429 }))
		vi.stubGlobal('fetch', fetchMock)
		const message = {
			from: 'no-reply@example.test',
			to: 'player@example.test',
			subject: 'Code',
			text: '123456',
			html: '<p>123456</p>',
		}

		await expect(new ResendEmail('re_test_key').send(message)).rejects.toThrow('HTTP 429')
		await expect(new ResendEmail(undefined).send(message)).rejects.toThrow('RESEND_API_KEY')
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})
