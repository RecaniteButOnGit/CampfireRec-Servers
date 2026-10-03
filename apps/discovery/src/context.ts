import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Static-asset fetcher for the page layouts in `static/` (see wrangler.jsonc
	 * `assets`). Fetched by filename so `{type}` is a wildcard; the binding is the only
	 * way in, since `run_worker_first` keeps the runtime from serving the files directly.
	 */
	ASSETS: Fetcher
	/** Optional server-side key for CV2 AIRequest calls. */
	OPENAIKEY?: SecretsStoreSecret
	/** Shared token required on CV2 commands. */
	RRTOKEN?: SecretsStoreSecret | string
	/** Shared room database and scene bucket used by CV2 Escapees imports. */
	DB: D1Database
	CDN_ASSETS: R2Bucket
	/** Optional override; the Escapees game currently uses https://api.escapees.net. */
	ESCAPEES_API_URL?: string
	MAX_ROOMS_PER_ACCOUNT?: string | number
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
