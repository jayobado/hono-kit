import { Hono } from 'hono'
import type {
	ServerOptions,
	RuntimeAdapter,
	Hono as HonoType,
} from './types.ts'
import {
	requestId,
	errorHandler,
	accessLog,
	securityHeaders,
	compress,
} from './middleware.ts'
import { Log } from './logger.ts'

// ─── Runtime detection ────────────────────────────────────────────────────────

function detectRuntime(): string {
	// deno-lint-ignore no-explicit-any
	const g = globalThis as any
	if (typeof g.Deno !== 'undefined') return 'deno'
	if (typeof g.process !== 'undefined' && g.process.versions?.node) return 'node'
	if (typeof g.caches !== 'undefined' && typeof g.HTMLRewriter !== 'undefined') return 'cloudflare'
	return 'unknown'
}

async function resolveAdapter(
	adapter?: RuntimeAdapter | 'deno' | 'node' | 'cloudflare'
): Promise<RuntimeAdapter> {
	if (adapter && typeof adapter === 'object') return adapter

	const runtime = adapter ?? detectRuntime()

	switch (runtime) {
		case 'deno': {
			const mod = await import('./adapters/deno.ts')
			return mod.denoAdapter
		}
		case 'node': {
			const mod = await import('./adapters/node.ts')
			return mod.nodeAdapter
		}
		case 'cloudflare': {
			const mod = await import('./adapters/cloudflare.ts')
			return mod.cloudflareAdapter
		}
		default:
			throw new Error(`[hono-kit] Unknown runtime: ${runtime}`)
	}
}

// ─── CORS resolution ─────────────────────────────────────────────────────────

function resolveCors(cors: ServerOptions['cors']): {
	origins: string[]
	methods: string[]
	allowHeaders: string[]
	credentials: boolean
	maxAge: number
} | undefined {
	if (!cors) return undefined
	if (Array.isArray(cors)) {
		return {
			origins: cors,
			methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization'],
			credentials: true,
			maxAge: 7200,
		}
	}
	return {
		origins: cors.origins,
		methods: cors.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowHeaders: cors.allowHeaders ?? ['Content-Type', 'Authorization'],
		credentials: cors.credentials ?? true,
		maxAge: cors.maxAge ?? 7200,
	}
}

// ─── createServer ─────────────────────────────────────────────────────────────

export async function createServer<T extends Record<string, unknown> = Record<string,unknown>>(opts: ServerOptions<T>): Promise < HonoType > {
	const {
		port = 3000,
		host = 'localhost',
		middleware =[],
		sessions,
		api,
		pages,
		spa,
		assets,
	} = opts

	const adapter = await resolveAdapter(opts.adapter)
	const app = new Hono()

	// ── Built-in middleware ────────────────────────────────────────────────

	app.use('*', errorHandler())
	app.use('*', requestId())
	app.use('*', compress())
	app.use('*', securityHeaders())
	app.use('*', accessLog())

	// ── Global CORS ───────────────────────────────────────────────────────

	const globalCors = resolveCors(opts.cors)
	if(globalCors) {
		const { cors: corsMiddleware } = await import('hono/cors')
		app.use('*', corsMiddleware({
			origin: globalCors.origins,
			credentials: globalCors.credentials,
			allowMethods: globalCors.methods,
			allowHeaders: globalCors.allowHeaders,
			maxAge: globalCors.maxAge,
		}))
	}

	// ── Session middleware ─────────────────────────────────────────────────

	if(sessions) {
		const { createSessionMiddleware } = await import('./auth.ts')
		app.use('*', createSessionMiddleware(sessions.store, sessions.cookie))
	}

	// ── Custom middleware ──────────────────────────────────────────────────

	for(const mw of middleware) {
		app.use('*', mw)
	}

	// ── API layer ─────────────────────────────────────────────────────────

	if(api) {
		const prefix = api.prefix ?? '/api'

		// API-specific CORS override
		const apiCors = resolveCors(api.cors)
		if (apiCors && !globalCors) {
			const { cors: corsMiddleware } = await import('hono/cors')
			app.use(`${prefix}/*`, corsMiddleware({
				origin: apiCors.origins,
				credentials: apiCors.credentials,
				allowMethods: apiCors.methods,
				allowHeaders: apiCors.allowHeaders,
				maxAge: apiCors.maxAge,
			}))
		}

		// API-specific middleware
		if (api.middleware?.length) {
			for (const mw of api.middleware) {
				app.use(`${prefix}/*`, mw)
			}
		}

		// API routes
		if (api.routes) {
			const apiApp = new Hono()
			api.routes(apiApp)
			app.route(prefix, apiApp)
		}
	}

	// ── Pages layer (BFF / SSR) ───────────────────────────────────────────

	if(pages) {
		pages(app)
	}

	// ── WebSocket layer ───────────────────────────────────────────────────

	if(opts.ws) {
	const { mountWebSocket } = await import('./ws.ts')
	mountWebSocket(app, opts.ws)
}

// ── SPA layer ─────────────────────────────────────────────────────────

if (spa) {
	const { mountSpa } = await import('./spa.ts')
	await mountSpa(app, spa, adapter)
}

// ── Static assets ─────────────────────────────────────────────────────

if (assets) {
	const { mountAssets } = await import('./assets.ts')
	const assetOpts = typeof assets === 'string'
		? { root: assets }
		: assets
	mountAssets(app, assetOpts)
}

// ── Start server ──────────────────────────────────────────────────────

adapter.serve(app, { host, port })

Log.info(`Server running at http://${host}:${port}`)
Log.info(`Runtime: ${adapter.name}`)
if (api) Log.info(`API: ${api.prefix ?? '/api'}`)
if (spa) Log.info(`SPA: ${spa.root ?? './client'} (${spa.strategy ?? 'lazy'})`)
if (opts.ws) Log.info(`WebSocket: ${opts.ws.path ?? '/ws'}`)

return app
}

// ─── For Cloudflare Workers — export the app without starting a server ────────

export function createApp<T extends Record<string, unknown> = Record<string, unknown>>(
	opts: Omit<ServerOptions<T>, 'port' | 'host' | 'adapter'>
): Hono {
	const {
		middleware = [],
		api,
		pages,
	} = opts

	const app = new Hono()

	// ── Built-in middleware ────────────────────────────────────────────────

	app.use('*', errorHandler())
	app.use('*', requestId())
	app.use('*', compress())
	app.use('*', securityHeaders())
	app.use('*', accessLog())

	// ── Custom middleware ──────────────────────────────────────────────────

	for (const mw of middleware) {
		app.use('*', mw)
	}

	// ── API layer ─────────────────────────────────────────────────────────

	if (api) {
		const prefix = api.prefix ?? '/api'

		if (api.middleware?.length) {
			for (const mw of api.middleware) {
				app.use(`${prefix}/*`, mw)
			}
		}

		if (api.routes) {
			const apiApp = new Hono()
			api.routes(apiApp)
			app.route(prefix, apiApp)
		}
	}

	// ── Pages layer ───────────────────────────────────────────────────────

	if (pages) {
		pages(app)
	}

	// Workers serves static assets via Pages or Workers Sites
	// SPA and WebSocket layers are not available in Workers — use build() + Pages

	return app
}