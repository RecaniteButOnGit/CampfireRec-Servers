// oxlint-disable @typescript-eslint/consistent-type-imports
type LocalEnv = import('./src/context').Env
type MainModule = typeof import('./src/link.app')

// Add Env to Cloudflare namespace so that we can access it via
// import { env } from 'cloudflare:workers'
declare namespace Cloudflare {
	interface Env extends LocalEnv {}
	interface GlobalProps {
		mainModule: MainModule
	}
}

// Tests read the migration as a string and apply it, so the schema has one source.
declare module '*.sql?raw' {
	const content: string
	export default content
}
