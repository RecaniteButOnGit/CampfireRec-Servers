import { Hono } from 'hono'

import type { Context } from 'hono'
import type { App } from './context'

type Release = {
	version: number
	label: string
	contentUrl: string
	partSize: number
	summary: Record<string, unknown>
}
type Distribution = {
	appSecretSha256: string
	latest: number
	releases: Release[]
	legacySummaries?: Record<string, Record<string, unknown>>
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown, minimum = 0): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const hex = (value: unknown, length: number): value is string =>
	typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)

function validSummary(value: unknown): value is Record<string, unknown> {
	if (!record(value) || !Array.isArray(value.files)) return false
	const paths = new Set<string>()
	return value.files.every((file: unknown) => {
		if (!record(file) || typeof file.path !== 'string' || !hex(file.hash, 8) || !integer(file.size))
			return false
		const path = file.path
		if (
			path.includes('\\') ||
			/[\p{Cc}<>:"|?*]/u.test(path) ||
			path
				.split('/')
				.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
			paths.has(path.toLowerCase())
		)
			return false
		paths.add(path.toLowerCase())
		return true
	})
}

function validCatalog(value: unknown): value is Distribution {
	if (
		!record(value) ||
		!hex(value.appSecretSha256, 64) ||
		!integer(value.latest, 1) ||
		!Array.isArray(value.releases) ||
		value.releases.length === 0
	)
		return false
	const versions = new Set<number>()
	for (const release of value.releases) {
		if (
			!record(release) ||
			!integer(release.version, 1) ||
			versions.has(release.version) ||
			typeof release.label !== 'string' ||
			!integer(release.partSize, 1) ||
			typeof release.contentUrl !== 'string' ||
			!validSummary(release.summary)
		)
			return false
		let url: URL
		try {
			url = new URL(release.contentUrl)
		} catch {
			return false
		}
		const summary = release.summary
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.hash ||
			summary.compression_method !== 'zip' ||
			!hex(summary.hash_code, 64) ||
			!integer(summary.size, 1) ||
			!record(summary.chunks) ||
			summary.chunks.size !== release.partSize ||
			!Array.isArray(summary.chunks.hashes) ||
			summary.chunks.hashes.length !== Math.ceil(summary.size / release.partSize) ||
			!summary.chunks.hashes.every((hash: unknown) => hex(hash, 8))
		)
			return false
		versions.add(release.version)
	}
	if (!versions.has(value.latest)) return false
	return (
		value.legacySummaries === undefined ||
		(record(value.legacySummaries) &&
			Object.entries(value.legacySummaries).every(
				([id, summary]) =>
					/^[1-9]\d*$/.test(id) &&
					Number.isSafeInteger(Number(id)) &&
					!versions.has(Number(id)) &&
					validSummary(summary)
			))
	)
}

/** Optional operator-published PatchKit catalog. No template or deployment identity in source. */
export default new Hono<App>().get('/1/apps/:secret/*', serve).get('/1/apps/:secret', serve)

async function serve(c: Context<App>) {
	c.header('Cache-Control', 'no-store')
	const key = c.env.STUDIO_DISTRIBUTION_MANIFEST
	if (!key) return c.notFound()
	const manifest = await c.env.CDN_ASSETS.get(key)
	if (!manifest) return c.notFound()
	if (manifest.size > 8 * 1024 * 1024) return c.body(null, 503)
	let catalog: unknown
	try {
		catalog = await manifest.json()
	} catch {
		return c.body(null, 503)
	}
	if (!validCatalog(catalog)) return c.body(null, 503)
	const secret = c.req.param('secret') ?? ''
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
	const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
	if (hash !== catalog.appSecretSha256) return c.notFound()
	const suffix = new URL(c.req.url).pathname.split('/').slice(4).join('/')
	const version = (release: Release) => {
		const contentGuid =
			typeof release.summary.hash_code === 'string'
				? release.summary.hash_code
				: String(release.version)
		return {
			id: release.version,
			label: release.label,
			changelog: release.label,
			published: true,
			draft: false,
			pending_publish: false,
			publish_progress: 1,
			main_executable: 'dummy.exe',
			main_executable_args: '',
			ignored_files: [],
			content_guid: contentGuid,
			content_meta_guid: contentGuid,
			patch_links: { incoming: [], outgoing: [] },
		}
	}
	if (suffix === '')
		return c.json({
			secret,
			display_name: 'Rec Room Studio',
			name: 'Rec Room Studio',
			platform: 'windows',
			current_version: catalog.latest,
			lowest_version_with_diff: 0,
			use_keys: false,
			use_token: false,
			use_password: false,
			patcher_whitelabel: false,
			patcher_download_speed_unit: 'bytes',
		})
	if (suffix === 'versions/latest/id') return c.json({ id: catalog.latest })
	if (suffix === 'changelog')
		return c.json({
			versions: catalog.releases.map((r) => ({
				vid: r.version,
				label: r.label,
				changelog: r.label,
			})),
		})
	if (suffix === 'versions') return c.json(catalog.releases.map(version))
	const match =
		/^versions\/(latest|[1-9]\d*)(?:\/(content_summary|content_urls|diff_summary|diff_urls))?$/.exec(
			suffix
		)
	if (!match) return c.notFound()
	// File-version comparisons need historical hashes, without offering the stock
	// template as an installable release or repeatedly returning 404 per file.
	const legacy = catalog.legacySummaries?.[match[1]!]
	if (match[2] === 'content_summary' && legacy) return c.json(legacy)
	if (!match[2] && legacy)
		return c.json(
			version({
				version: Number(match[1]),
				label: `v${match[1]}`,
				summary: legacy,
				partSize: 0,
				contentUrl: '',
			})
		)
	const release = catalog.releases.find(
		(r) => r.version === (match[1] === 'latest' ? catalog.latest : Number(match[1]))
	)
	if (!release) return c.notFound()
	if (match[2] === 'content_summary') return c.json(release.summary)
	if (match[2] === 'diff_summary') {
		// A full-replacement update, rather than binary deltas. A successful empty
		// delta list is cached by PatchKit; a 404 is retried for every installed file.
		const { files, ...summary } = release.summary
		return c.json({
			...summary,
			added_files: (files as Array<{ path: string }>).map((file) => file.path),
			modified_files: [],
			unchanged_files: [],
			removed_files: [],
		})
	}
	if (match[2] === 'content_urls' || match[2] === 'diff_urls')
		return c.json([{ url: release.contentUrl, part_size: release.partSize }])
	return c.json(version(release))
}
