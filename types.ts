import type { Hono, Context, MiddlewareHandler } from "hono"

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { Hono, Context, MiddlewareHandler }

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionStore<T extends Record<string, unknown> = Record<string, unknown>> {
	get: (sid: string) => Promise<T | undefined>
	set: (sid: string, data: T, ttl?: number) => Promise<void>
	delete: (sid: string) => Promise<void>
	touch?: (sid: string, ttl?: number) => Promise<void>
}

export interface CookieOptions {
	name?: string
	maxAge?: number
	secure?: boolean
	sameSite?: 'Strict' | 'Lax' | 'None'
	httpOnly?: boolean
	path?: string
}

export interface CredentialOptions<T> {
	field: keyof T
	header?: string
	format?: (value: string) => string
}

export interface RefreshOptions<T> {
	isExpired: (session: T) => boolean
	renew: (session: T) => Promise<T>
}

export interface AuthOptions<T extends Record<string, unknown>> {
	store: SessionStore<T>
	cookie?: CookieOptions
	extract: (response: unknown) => T
	credential?: CredentialOptions<T>
	refresh?: RefreshOptions<T>
}

// ─── SPA ──────────────────────────────────────────────────────────────────────

export interface SpaOptions {
	root?: string
	importMap?: string | { imports: Record<string, string> }
	lockFile?: string
	strategy?: 'lazy' | 'eager' | 'build'
	compilerOptions?: Record<string, unknown>
	hmr?: boolean
}

// ─── API ──────────────────────────────────────────────────────────────────────

export interface ApiOptions {
	prefix?: string
	cors?: CorsOptions | string[]
	routes?: (app: Hono) => void
	middleware?: MiddlewareHandler[]
}

export interface CorsOptions {
	origins: string[]
	methods?: string[]
	allowHeaders?: string[]
	credentials?: boolean
	maxAge?: number
}

// ─── Assets ───────────────────────────────────────────────────────────────────

export interface AssetsOptions {
	root: string
	prefix?: string
	maxAge?: number
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

export interface WsConnection<T = Record<string, unknown>> {
	id: string
	session?: T
	metadata: Record<string, unknown>
	send: (data: unknown) => void
	close: (code?: number, reason?: string) => void
	channels: Set<string>
}

export interface ChannelApi {
	join: (channel: string) => void
	leave: (channel: string) => void
	broadcast: (channel: string, data: unknown, exclude?: string) => void
	members: (channel: string) => string[]
}

export interface WsOptions<T = Record<string, unknown>> {
	path?: string
	authenticate?: (c: Context) => Promise<T | false>
	events?: EventBus
	ping?: { interval?: number; timeout?: number }
	onConnect?: (conn: WsConnection<T>, channels: ChannelApi) => void
	onMessage?: (conn: WsConnection<T>, data: unknown, channels: ChannelApi) => void
	onClose?: (conn: WsConnection<T>) => void
	onError?: (conn: WsConnection<T>, err: unknown) => void
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface EventBus {
	emit: (channel: string, data: unknown) => void
	on: (channel: string, handler: (data: unknown) => void) => () => void
	stream: (c: Context, channel: string) => Response
}

export interface BroadcastAdapter {
	publish: (channel: string, data: unknown) => Promise<void>
	subscribe: (channel: string, handler: (data: unknown) => void) => Promise<void>
	unsubscribe: (channel: string) => Promise<void>
}

// ─── Transpiler ───────────────────────────────────────────────────────────────

export interface Transpiler {
	transpile: (specifier: string, opts: TranspileFileOptions) => Promise<string | null>
	warm?: (root: string, opts: TranspileFileOptions) => Promise<number>
}

export interface TranspileFileOptions {
	importMap?: string | { imports: Record<string, string> }
	compilerOptions?: Record<string, unknown>
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export interface RuntimeAdapter {
	name: string
	serve: (app: Hono, opts: { host: string; port: number }) => void
	readFile?: (path: string) => Promise<string>
	readBinary?: (path: string) => Promise<Uint8Array>
	readDir?: (path: string) => AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>
	writeFile?: (path: string, content: string) => Promise<void>
	mkdir?: (path: string) => Promise<void>
	createTranspiler?: () => Transpiler
}

// ─── Server ───────────────────────────────────────────────────────────────────

export interface ServerOptions<T extends Record<string, unknown> = Record<string, unknown>> {
	port?: number
	host?: string
	adapter?: RuntimeAdapter | 'deno' | 'node' | 'cloudflare'
	middleware?: MiddlewareHandler[]
	cors?: CorsOptions | string[]
	sessions?: {
		store: SessionStore<T>
		cookie?: CookieOptions
	}
	api?: ApiOptions
	pages?: (app: Hono) => void
	spa?: SpaOptions
	assets?: string | AssetsOptions
	ws?: WsOptions<T>
}

// ─── Build ────────────────────────────────────────────────────────────────────

export interface BuildOptions {
	entry: string
	outDir?: string
	importMap?: string | { imports: Record<string, string> }
	minify?: boolean
	compilerOptions?: Record<string, unknown>
}