/**
 * @module
 * Thin composer for API apps. Wires the pieces you pass into a Hono app
 * and returns it. Nothing is auto-mounted that you didn't explicitly include.
 *
 *   const auth = createAuth({ ... })
 *   const orderRoutes = defineRoutes([ ... ])
 *
 *   const app = createApiApp({
 *     middleware: [requestId(), accessLog(), errorHandler()],
 *     auth,
 *     routes: orderRoutes,
 *     health: { version: '1.0.0' },
 *   })
 *   serveDeno(app, { port: 3000 })
 */

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { Auth } from '../auth.ts'
import { mountHealth, type HealthOptions } from '../health.ts'

export interface ApiAppOptions<S extends Record<string, unknown> = Record<string, unknown>> {
	/** Middleware applied to every request. Order matters. */
	middleware?: MiddlewareHandler[]
	/** Auth instance. If provided, auth.middleware() is mounted globally. */
	auth?: Auth<S>
	/** Route sub-app from defineRoutes(). Mounted at routesPrefix (default '/'). */
	routes?: Hono
	/** Prefix for the routes sub-app. Default '/'. */
	routesPrefix?: string
	/** WebSocket handler + path. */
	ws?: { path: string; handler: (c: Context) => Response | Promise<Response> }
	/** Health/ready/version endpoints. */
	health?: HealthOptions
}

export function createApiApp<S extends Record<string, unknown> = Record<string, unknown>>(
	opts: ApiAppOptions<S> = {},
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

	if (opts.routes) {
		app.route(opts.routesPrefix ?? '/', opts.routes)
	}

	return app
}