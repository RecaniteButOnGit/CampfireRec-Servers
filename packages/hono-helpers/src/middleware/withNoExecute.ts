import type { MiddlewareHandler } from 'hono'

/**
 * Headers that keep a served object from running as a document.
 *
 * `img` and `cdn` stream user uploads back from R2, where an object carries whatever
 * content-type the uploader claimed — so a `text/html` body under a `.jpg` name is an HTML
 * page on that origin unless the response says otherwise. `nosniff` stops the browser
 * upgrading an image or octet-stream type to HTML on its own, and the `sandbox` CSP denies
 * scripts, plugins and same-origin access even when the stored type really is HTML or SVG:
 * the page renders inert. Nothing either worker serves should ever execute, so these go on
 * every response, the status JSON and 304s included.
 */
export const NO_EXECUTE_HEADERS = {
	'x-content-type-options': 'nosniff',
	'content-security-policy': "default-src 'none'; sandbox",
} as const

/** Stamp the no-execute headers onto a response built outside Hono (a hand-rolled HEAD). */
export function applyNoExecuteHeaders(headers: Headers): void {
	for (const [name, value] of Object.entries(NO_EXECUTE_HEADERS)) headers.set(name, value)
}

/**
 * Apply `NO_EXECUTE_HEADERS` to every response of the app. Set after `next()`, like
 * `withDefaultCors`, so the route's Response is mutated rather than rebuilt and a HEAD's
 * `encodeBody: 'manual'` Content-Length survives.
 */
export function withNoExecute(): MiddlewareHandler {
	return async (c, next) => {
		try {
			await next()
		} finally {
			applyNoExecuteHeaders(c.res.headers)
		}
	}
}
