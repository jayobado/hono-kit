/**
 * @module
 * Public API for @jayobado/hono-kit. A toolkit of composable primitives for
 * building Hono-based API services and BFFs. Each primitive is independent;
 * the archetype builders (createApiApp, createBff) are thin composers that
 * wire pieces together without hidden behavior.
 *
 * Cloudflare KV / Durable Object session stores are in a separate entry point
 * to keep CF types out of the main bundle:
 *
 *   import { createKvSessionStore } from '@jayobado/hono-kit/cf-stores'
 */

// ─── Auth + sessions ─────────────────────────────────────────────────────────
export { createAuth } from './auth.ts'
export type {
	Auth,
	AuthOptions,
	SessionStore,
	CookieOptions,
	CredentialOptions,
	RefreshOptions,
} from './auth.ts'

export { createMemoryStore } from './stores/memory.ts'

// ─── Routes ──────────────────────────────────────────────────────────────────
export { defineRoute, defineRoutes } from './routes.ts'
export type {
	HttpMethod,
	RouteDescriptor,
	RouteHandler,
	ValidationIssue,
	IssueSource,
	DefineRoutesOptions,
} from './routes.ts'

// ─── Upstream ────────────────────────────────────────────────────────────────
export { createUpstream, UpstreamError } from './upstream.ts'
export type { Upstream, UpstreamOptions } from './upstream.ts'

// ─── Archetype composers ────────────────────────────────────────────────────
export { createApiApp } from './app/api.ts'
export type { ApiAppOptions } from './app/api.ts'

export { createBff } from './app/bff.ts'
export type { BffOptions } from './app/bff.ts'

// ─── Health ──────────────────────────────────────────────────────────────────
export { mountHealth } from './health.ts'
export type { HealthOptions } from './health.ts'

// ─── SPA ─────────────────────────────────────────────────────────────────────
export { createDevServer } from './spa/dev.ts'
export type { DevServerOptions, DevServer } from './spa/dev.ts'

export { createTranspileServer } from './spa/transpile.ts'
export type { TranspileServerOptions, TranspileServer } from './spa/transpile.ts'

export { serveAssets } from './spa/assets.ts'
export type { AssetManifest, ServeAssetsOptions } from './spa/assets.ts'

export { createHmr, watchFs, injectHmrClient } from './spa/hmr.ts'
export type { Hmr, HmrMessage, WatchEvent } from './spa/hmr.ts'

// ─── Build ───────────────────────────────────────────────────────────────────
export { build } from './bundle.ts'
export type { BuildOptions, BuildResult } from './bundle.ts'

// ─── WebSocket + events ──────────────────────────────────────────────────────
export { createWsHandler, createChannels } from './ws.ts'
export type { WsConnection, WsHandlerOptions, WsHandler, Channels } from './ws.ts'

export { createEventBus } from './events.ts'
export type { EventBus } from './events.ts'

// ─── Middleware ──────────────────────────────────────────────────────────────
export {
	requestId,
	accessLog,
	errorHandler,
	securityHeaders,
	compress,
} from './middleware.ts'

// ─── Runtime helpers ─────────────────────────────────────────────────────────
export { serveDeno, serveNode, onShutdown, runShutdown } from './runtime.ts'
export type { ServerHandle, ServeOptions } from './runtime.ts'

// ─── Logger ──────────────────────────────────────────────────────────────────
export { Log } from './logger.ts'