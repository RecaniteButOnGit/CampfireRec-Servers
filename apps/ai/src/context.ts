import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

export type Env = SharedHonoEnv & {
	/**
	 * Shared Secrets Store binding for the HS256 JWT signing key. Resolve the value with
	 * `await env.JWT_SECRET.get()`; every worker binds the same store, so tokens signed by
	 * `auth` verify here.
	 */
	JWT_SECRET: SecretsStoreSecret
	/** Optional server-side OpenAI key used only when creating Roomie sessions. */
	OPENAIKEY?: SecretsStoreSecret
	/** Realtime model for newly minted Roomie sessions. */
	OPENAI_REALTIME_MODEL?: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
