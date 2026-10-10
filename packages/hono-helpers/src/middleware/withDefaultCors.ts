import { cors } from 'hono/cors'

import type { MiddlewareHandler } from 'hono'

const preflight = cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
	allowHeaders: ['Content-Type', 'Authorization'],
})

/**
 * Browser callers need `Access-Control-Allow-Origin`. Hono's `cors()` writes
 * that header before `next()`, which creates `c.res`. The route's Response is
 * then rebuilt with `new Response(body, res)`, and that rebuild drops
 * `encodeBody`. workerd removes `Content-Length` from a null body unless
 * `encodeBody` is `manual`, so a HEAD that reports a size lost the length.
 * Set the header after `next()` so the route's Response stays as it was.
 * OPTIONS still uses Hono's preflight response.
 */
export function withDefaultCors(): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.method === 'OPTIONS') return preflight(c, next)
		if ((c.req.header('upgrade') ?? '').toLowerCase() === 'websocket') return next()
		try {
			await next()
		} finally {
			c.res.headers.set('Access-Control-Allow-Origin', '*')
		}
	}
}
