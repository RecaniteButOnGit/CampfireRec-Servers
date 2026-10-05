/**
 * Baked unity asset bundles — the blob references behind a room's asset-bundle download.
 *
 * `unity_asset` holds one row per BUILD of a unity asset: the asset's GUID, the `Target`
 * it was built for (0 Windows, 2 Android/Quest — the same numbers a custom avatar's
 * `unityAssetTarget` uses), its `Version`, and the storage blob the client downloads
 * (`Filename`, a `<date>/<guid>` path, and its base64 SHA-256 `Hash`). The client asks for
 * these in bulk from `POST /unity_assets/baked/bulk` (the `rooms` worker) while loading a
 * room — the step Player.log times as `AssetBundle_Download` — and downloads `Filename`
 * from the CDN; a lookup that answers no row, or a row without a `Filename`, simply
 * downloads nothing, with no error anywhere.
 *
 * This is a separate store from the Rec Room Studio builds in `studio_unity_asset_file`
 * (see studio-unity-assets.ts), which the studio worker writes per platform and kind and
 * which `GET /rooms/{id}` folds onto `CurrentSave.UnitySubAssets`. Nothing writes this
 * table yet; it is the record the bulk lookup reads.
 *
 * The `rooms` worker owns the table and its migration — see
 * apps/rooms/migrations/0024_unity_asset.sql.
 */

import { bindPlaceholders, chunkForBinds } from './d1-binds'

/** Schema DDL (mirror of apps/rooms/migrations/0024_unity_asset.sql) — tests apply this. */
export const UNITY_ASSET_SCHEMA_DDL: string[] = [
	// A unity asset is built once per target, and may be rebuilt at a new version, so the
	// three together name a row. `unity_asset_id` is stored lowercase: a GUID's case is not
	// part of its identity and the client is not consistent about it.
	`CREATE TABLE IF NOT EXISTS unity_asset (
		unity_asset_id TEXT NOT NULL,
		target INTEGER NOT NULL,
		version INTEGER NOT NULL,
		filename TEXT NOT NULL,
		hash TEXT NOT NULL,
		PRIMARY KEY (unity_asset_id, target, version)
	)`,
]

/**
 * One baked bundle as the client reads it — its five-key DTO, in this order. An element of
 * the bare array `POST /unity_assets/baked/bulk` answers.
 */
export interface BakedUnityAsset {
	/** GUID. */
	UnityAssetId: string
	/** 0 Windows, 2 Android/Quest. */
	Target: number
	Version: number
	/** The storage blob path the client downloads, `<date>/<guid>`. */
	Filename: string
	/** Base64 SHA-256 of the blob. */
	Hash: string
}

interface UnityAssetRow {
	unity_asset_id: string
	target: number
	version: number
	filename: string
	hash: string
}

const toBakedUnityAsset = (row: UnityAssetRow): BakedUnityAsset => ({
	UnityAssetId: row.unity_asset_id,
	Target: row.target,
	Version: row.version,
	Filename: row.filename,
	Hash: row.hash,
})

/** Record a build. Replaces the row for the same (asset, target, version). */
export async function putUnityAsset(db: D1Database, asset: BakedUnityAsset): Promise<void> {
	await db
		.prepare(
			`INSERT OR REPLACE INTO unity_asset (unity_asset_id, target, version, filename, hash)
			 VALUES (?1, ?2, ?3, ?4, ?5)`
		)
		.bind(asset.UnityAssetId.toLowerCase(), asset.Target, asset.Version, asset.Filename, asset.Hash)
		.run()
}

/**
 * The baked bundles for `unityAssetIds` on `target` — one entry per asset that has one, in
 * the order asked, assets with no build left out. An asset built more than once is served
 * ONCE: the build at the requested `version` when there is one, otherwise the newest. The
 * request's version is a preference, not a filter, because the one capture pairing the two
 * (a request for version 3 answered with version 227) shows the reference did not require
 * them to match, and an empty answer here is a room that silently loads nothing.
 *
 * Ids are matched case-insensitively and served as stored (lowercase). Nothing to ask
 * about reads nothing.
 */
export async function getBakedUnityAssets(
	db: D1Database,
	unityAssetIds: string[],
	target: number,
	version: number
): Promise<BakedUnityAsset[]> {
	const ids = [...new Set(unityAssetIds.map((id) => id.toLowerCase()))]
	if (ids.length === 0) return []
	const pages = await Promise.all(
		chunkForBinds(ids, 2).map((chunk) =>
			db
				.prepare(
					`SELECT unity_asset_id, target, version, filename, hash FROM unity_asset
					 WHERE target = ?1 AND unity_asset_id IN (${bindPlaceholders(chunk, 2)})
					 ORDER BY (version = ?2) DESC, version DESC`
				)
				.bind(target, version, ...chunk)
				.all<UnityAssetRow>()
		)
	)
	// Rows arrive best-first per asset, so the first one seen for an id is the one to serve.
	const best = new Map<string, BakedUnityAsset>()
	for (const row of pages.flatMap((page) => page.results)) {
		if (!best.has(row.unity_asset_id)) best.set(row.unity_asset_id, toBakedUnityAsset(row))
	}
	return ids.flatMap((id) => best.get(id) ?? [])
}
