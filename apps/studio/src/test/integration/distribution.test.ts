import { env, SELF } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

const origin = 'https://example.com/1/apps/template-fixture'
beforeEach(async () => {
	env.STUDIO_DISTRIBUTION_MANIFEST = 'distribution/catalog.json'
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('template-fixture'))
	await env.CDN_ASSETS.put(
		env.STUDIO_DISTRIBUTION_MANIFEST,
		JSON.stringify({
			appSecretSha256: Array.from(new Uint8Array(digest), (b) =>
				b.toString(16).padStart(2, '0')
			).join(''),
			latest: 170,
			legacySummaries: { '169': { files: [{ path: 'original.tgz', hash: '87654321', size: 80 }] } },
			releases: [
				{
					version: 170,
					label: 'v170',
					partSize: 32,
					contentUrl: 'https://cdn.example.test/template.zip',
					summary: {
						hash_code: 'a'.repeat(64),
						compression_method: 'zip',
						size: 50,
						files: [{ path: 'patched.tgz', hash: '12345678', size: 80 }],
						chunks: { size: 32, hashes: ['12345678', '87654321'] },
					},
				},
			],
		})
	)
})
it('serves the prepatched v170 catalog and complete multipart download contract', async () => {
	expect(await (await SELF.fetch(origin + '/changelog')).json()).toEqual({
		versions: [{ vid: 170, label: 'v170', changelog: 'v170' }],
	})
	expect(await (await SELF.fetch(origin + '/versions/latest/id')).json()).toEqual({ id: 170 })
	expect(await (await SELF.fetch(origin)).json()).toMatchObject({
		current_version: 170,
		use_keys: false,
	})
	expect(await (await SELF.fetch(origin + '/versions/170')).json()).toMatchObject({
		id: 170,
		label: 'v170',
		patch_links: { incoming: [], outgoing: [] },
		content_guid: 'a'.repeat(64),
	})
	expect(await (await SELF.fetch(origin + '/versions/170/content_urls')).json()).toEqual([
		{ url: 'https://cdn.example.test/template.zip', part_size: 32 },
	])
	expect(await (await SELF.fetch(origin + '/versions/170/content_summary')).json()).toMatchObject({
		compression_method: 'zip',
		chunks: { hashes: ['12345678', '87654321'] },
	})
})

it('rejects malformed or unsafe catalogs without caching a broken update response', async () => {
	const key = env.STUDIO_DISTRIBUTION_MANIFEST!
	const original = await (await env.CDN_ASSETS.get(key))!.text()
	for (const change of [
		(c: any) => {
			c.latest = 171
		},
		(c: any) => {
			c.releases.push(c.releases[0])
		},
		(c: any) => {
			c.legacySummaries['170'] = c.legacySummaries['169']
		},
		(c: any) => {
			c.releases[0].contentUrl = 'http://cdn.example.test/content.zip'
		},
		(c: any) => {
			c.releases[0].summary.files[0].path = '../outside'
		},
		(c: any) => {
			c.releases[0].summary.files = null
		},
		(c: any) => {
			delete c.releases[0].summary.hash_code
		},
		(c: any) => {
			c.releases[0].summary.chunks.hashes = []
		},
	]) {
		const catalog = JSON.parse(original)
		change(catalog)
		await env.CDN_ASSETS.put(key, JSON.stringify(catalog))
		const response = await SELF.fetch(origin + '/versions/170/diff_summary')
		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
	}
	await env.CDN_ASSETS.put(key, '{')
	expect((await SELF.fetch(origin)).status).toBe(503)
	await env.CDN_ASSETS.put(key, ' '.repeat(8 * 1024 * 1024 + 1))
	expect((await SELF.fetch(origin)).status).toBe(503)
})
it('does not route other applications, missing versions, or disabled catalogs', async () => {
	expect((await SELF.fetch('https://example.com/1/apps/unrelated/versions/latest/id')).status).toBe(
		404
	)
	expect(await (await SELF.fetch(origin + '/versions/169')).json()).toMatchObject({
		id: 169,
		label: 'v169',
	})
	expect((await SELF.fetch(origin + '/versions/168')).status).toBe(404)
	expect((await SELF.fetch(origin + '/versions/169/content_urls')).status).toBe(404)
	delete env.STUDIO_DISTRIBUTION_MANIFEST
	expect((await SELF.fetch(origin + '/versions/latest/id')).status).toBe(404)
})

it('provides cached comparison and full-replacement update metadata without legacy downloads', async () => {
	expect(await (await SELF.fetch(origin + '/versions/169/content_summary')).json()).toMatchObject({
		files: [{ path: 'original.tgz', hash: '87654321' }],
	})
	expect(await (await SELF.fetch(origin + '/versions/170/diff_summary')).json()).toMatchObject({
		compression_method: 'zip',
		added_files: ['patched.tgz'],
		modified_files: [],
		unchanged_files: [],
	})
	expect(await (await SELF.fetch(origin + '/versions/170/diff_urls')).json()).toEqual([
		{ url: 'https://cdn.example.test/template.zip', part_size: 32 },
	])
})
