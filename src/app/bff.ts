/**
 * @module
 * Thin composer for BFF apps. Wires auth, API routes, optional WebSocket,
 * and a SPA handler into a single Hono app.
 *
 * The SPA argument is a Hono app produced by createDevServer.app,
 * (await createTranspileServer(...)).app, or serveAssets(...). The composer
 * doesn't decide which mode you want — you pass the prepared handler.
 *
 *   // Dev mode
 *   const dev = createDevServer({ root: './client', importMap: './deno.json' })
 *   const bff = createBff({
 *     middleware: [requestId(), accessLog(), errorHandler()],
 *     auth,
 *     api: bffRoutes,
 *     spa: dev.app,
 *   })
 *   serveDeno(bff, { port: 3000 })
 *   // ...on shutdown: dev.dispose()
 *
 *   // Build mode
 *   const assets = serveAssets({ root: './dist', manifest })
 *   const bff = createBff({ auth, api: bffRoutes, spa: assets })
 */

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { Auth } from '../auth.ts'
import { mountHealth, type HealthOptions } from '../health.ts'

export interface BffOptions<S extends Record<string, unknown> = Record<string, unknown>> {
	/** Middleware applied to every request. */
	middleware?: MiddlewareHandler[]
	/** Auth instance. If provided, auth.middleware() is mounted globally. */
	auth?: Auth<S>
	/** API route sub-app from defineRoutes(). Mounted at apiPrefix. */
	api?: Hono
	/** Prefix for the API routes. Default '/api'. */
	apiPrefix?: string
	/** WebSocket handler + path. */
	ws?: { path: string; handler: (c: Context) => Response | Promise<Response> }
	/** Health/ready endpoints. */
	health?: HealthOptions
	/**
	 * SPA handler — a Hono app from createDevServer.app, createTranspileServer.app,
	 * or serveAssets. Mounted last so API/WS/health routes take precedence.
	 */
	spa?: Hono
}

export function createBff<S extends Record<string, unknown> = Record<string, unknown>>(
	opts: BffOptions<S> = {},
): Hono {
	const app = new Hono()

	for (const mw of opts.middleware ?? []) {
		app.use('*', mw)
	}

	if (opts.auth) {
		app.use('*', opts.auth.middleware())
	}

	if (opts.health) {
		mountHealth(app, opts.health)
	}

	if (opts.ws) {
		app.get(opts.ws.path, opts.ws.handler)
	}

	if (opts.api) {
		app.route(opts.apiPrefix ?? '/api', opts.api)
	}

	// SPA mounted last so API + WS + health take precedence.
	if (opts.spa) {
		app.route('/', opts.spa)
	}

	return app
}