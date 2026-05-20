/**
 * @module
 * Auth and session management for hono-kit. Combines session lifecycle, cookie
 * handling, upstream credential storage and relay, and access guards into a
 * single typed Auth<T> instance.
 *
 * Two transport modes:
 *   - Stateful: pair createAuth with a SessionStore (memory, kv, durable-object).
 *   - Stateless: encrypted session data in the cookie itself, no store needed.
 */

import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { Context, MiddlewareHandler } from 'hono'

// ─── Session store interface ─────────────────────────────────────────────────

/** Storage backend for sessions. Implementations: memory, kv, durable-object. */
export interface SessionStore<T extends Record<string, unknown> = Record<string, unknown>> {
	get(sid: string): Promise<T | undefined>
	set(sid: string, data: T, ttl?: number): Promise<void>
	delete(sid: string): Promise<void>
	touch?(sid: string, ttl?: number): Promise<void>
}

// ─── Configuration types ─────────────────────────────────────────────────────

/** Cookie attributes. `domain` is required for multi-portal subdomain scoping. */
export interface CookieOptions {
	name?: string
	maxAge?: number
	secure?: boolean
	sameSite?: 'Strict' | 'Lax' | 'None'
	httpOnly?: boolean
	path?: string
	domain?: string
}

/** Maps a session field to an outbound credential header. */
export interface CredentialOptions<T> {
	field: keyof T
	header?: string
	format?: (value: string) => string
}

/** Transparent upstream-token refresh hooks. */
export interface RefreshOptions<T> {
	isExpired: (session: T) => boolean
	renew: (session: T) => Promise<T>
}

interface AuthBase<T extends Record<string, unknown>> {
	cookie?: CookieOptions
	toSession: (loginResponse: unknown) => T
	credential?: CredentialOptions<T>
	refresh?: RefreshOptions<T>
	unauthorized?: (c: Context) => Response
	forbidden?: (c: Context) => Response
}

export type AuthOptions<T extends Record<string, unknown>> =
	& AuthBase<T>
	& (
		| { store: SessionStore<T>; stateless?: never }
		| { stateless: { secret: string }; store?: never }
	)

/** Auth handle returned by createAuth(). */
export interface Auth<T extends Record<string, unknown>> {
	login(c: Context, loginResponse: unknown): Promise<T>
	logout(c: Context): Promise<void>
	middleware(): MiddlewareHandler
	getSession(c: Context): T | undefined
	getToken(c: Context): string | undefined
	backendHeaders(c: Context): Record<string, string>
	require(): MiddlewareHandler
	requireRole(check: (session: T) => boolean, message?: string): MiddlewareHandler
}

// ─── Defaults ────────────────────────────────────────────────────────────────

function resolveCookie(
	opts?: CookieOptions,
): Required<Omit<CookieOptions, 'domain'>> & { domain?: string } {
	return {
		name: opts?.name ?? 'sid',
		maxAge: opts?.maxAge ?? 60 * 60 * 24 * 7,
		secure: opts?.secure ?? true,
		sameSite: opts?.sameSite ?? 'Lax',
		httpOnly: opts?.httpOnly ?? true,
		path: opts?.path ?? '/',
		domain: opts?.domain,
	}
}

function setCookieAttrs(cookie: ReturnType<typeof resolveCookie>) {
	return {
		httpOnly: cookie.httpOnly,
		secure: cookie.secure,
		sameSite: cookie.sameSite,
		path: cookie.path,
		maxAge: cookie.maxAge,
		...(cookie.domain ? { domain: cookie.domain } : {}),
	}
}

function defaultUnauthorized(c: Context): Response {
	return c.json({ message: 'Unauthorized', code: 401 }, 401)
}

function defaultForbidden(c: Context, message?: string): Response {
	return c.json({ message: message ?? 'Forbidden', code: 403 }, 403)
}

// ─── createAuth ──────────────────────────────────────────────────────────────

export function createAuth<T extends Record<string, unknown>>(
	opts: AuthOptions<T>,
): Auth<T> {
	const cookie = resolveCookie(opts.cookie)
	const isStateless = 'stateless' in opts && opts.stateless !== undefined
	const unauthorized = opts.unauthorized ?? defaultUnauthorized

	// Per-sid in-flight refresh dedup. Prevents double-refresh under concurrent
	// requests that all observe the same expired session simultaneously.
	const refreshing = new Map<string, Promise<T>>()

	async function refreshSession(sid: string, session: T): Promise<T> {
		let inflight = refreshing.get(sid)
		if (inflight) return inflight
		inflight = (async () => {
			try {
				return await opts.refresh!.renew(session)
			} finally {
				refreshing.delete(sid)
			}
		})()
		refreshing.set(sid, inflight)
		return inflight
	}

	async function writeSession(
		c: Context,
		session: T,
		sidIfStateful?: string,
	): Promise<string> {
		if (isStateless) {
			const encrypted = await encrypt(session, opts.stateless!.secret)
			setCookie(c, cookie.name, encrypted, setCookieAttrs(cookie))
			return encrypted
		}
		const sid = sidIfStateful ?? crypto.randomUUID()
		await opts.store!.set(sid, session, cookie.maxAge)
		setCookie(c, cookie.name, sid, setCookieAttrs(cookie))
		return sid
	}

	return {
		// ── Login ────────────────────────────────────────────────────────────

		async login(c, loginResponse) {
			const session = opts.toSession(loginResponse)
			await writeSession(c, session)
			return session
		},

		// ── Logout ───────────────────────────────────────────────────────────

		async logout(c) {
			const value = getCookie(c, cookie.name)
			if (value && !isStateless) {
				await opts.store!.delete(value)
			}
			deleteCookie(c, cookie.name, {
				path: cookie.path,
				...(cookie.domain ? { domain: cookie.domain } : {}),
			})
		},

		// ── Resolve middleware ───────────────────────────────────────────────

		middleware() {
			return createMiddleware(async (c, next) => {
				const value = getCookie(c, cookie.name)
				if (!value) {
					c.set('session', undefined)
					return next()
				}

				let session: T | undefined
				if (isStateless) {
					session = await decrypt<T>(value, opts.stateless!.secret)
				} else {
					session = await opts.store!.get(value)
				}

				if (!session) {
					c.set('session', undefined)
					return next()
				}

				// Transparent refresh if expired.
				if (opts.refresh && opts.refresh.isExpired(session)) {
					try {
						session = await refreshSession(value, session)
						await writeSession(c, session, isStateless ? undefined : value)
					} catch {
						if (!isStateless) await opts.store!.delete(value)
						deleteCookie(c, cookie.name, {
							path: cookie.path,
							...(cookie.domain ? { domain: cookie.domain } : {}),
						})
						c.set('session', undefined)
						return next()
					}
				}

				// Extend TTL on activity (stateful only).
				if (!isStateless && opts.store!.touch) {
					await opts.store!.touch(value, cookie.maxAge)
				}

				c.set('session', session)
				await next()
			})
		},

		// ── Session accessors ────────────────────────────────────────────────

		getSession(c) {
			return c.get('session') as T | undefined
		},

		getToken(c) {
			const session = c.get('session') as T | undefined
			if (!session || !opts.credential) return undefined
			const value = session[opts.credential.field]
			return typeof value === 'string' ? value : undefined
		},

		backendHeaders(c) {
			const session = c.get('session') as T | undefined
			if (!session || !opts.credential) return {}

			const value = session[opts.credential.field]
			if (typeof value !== 'string' || !value) return {}

			const header = opts.credential.header ?? 'Authorization'
			const format = opts.credential.format ?? ((v: string) => `Bearer ${v}`)
			return { [header]: format(value) }
		},

		// ── Guards ───────────────────────────────────────────────────────────

		require() {
			return createMiddleware(async (c, next) => {
				const session = c.get('session') as T | undefined
				if (!session) return unauthorized(c)
				await next()
			})
		},

		requireRole(check, message) {
			return createMiddleware(async (c, next) => {
				const session = c.get('session') as T | undefined
				if (!session) return unauthorized(c)
				if (!check(session)) {
					return opts.forbidden
						? opts.forbidden(c)
						: defaultForbidden(c, message)
				}
				await next()
			})
		},
	}
}

// ─── Stateless cookie encryption ─────────────────────────────────────────────

const enc = new TextEncoder()
const dec = new TextDecoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function deriveKey(secret: string): Promise<CryptoKey> {
	let promise = keyCache.get(secret)
	if (!promise) {
		promise = (async () => {
			const keyMaterial = await crypto.subtle.importKey(
				'raw',
				enc.encode(secret),
				'PBKDF2',
				false,
				['deriveKey'],
			)
			return crypto.subtle.deriveKey(
				{
					name: 'PBKDF2',
					salt: enc.encode('hono-kit-session'),
					iterations: 100_000,
					hash: 'SHA-256',
				},
				keyMaterial,
				{ name: 'AES-GCM', length: 256 },
				false,
				['encrypt', 'decrypt'],
			)
		})()
		keyCache.set(secret, promise)
	}
	return promise
}

async function encrypt<T>(data: T, secret: string): Promise<string> {
	const key = await deriveKey(secret)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const plaintext = enc.encode(JSON.stringify(data))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		plaintext,
	)
	const combined = new Uint8Array(iv.length + ciphertext.byteLength)
	combined.set(iv)
	combined.set(new Uint8Array(ciphertext), iv.length)
	return btoa(String.fromCharCode(...combined))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

async function decrypt<T>(token: string, secret: string): Promise<T | undefined> {
	try {
		const key = await deriveKey(secret)
		const padded = token.replace(/-/g, '+').replace(/_/g, '/') +
			'='.repeat((4 - token.length % 4) % 4)
		const combined = Uint8Array.from(atob(padded), c => c.charCodeAt(0))
		const iv = combined.slice(0, 12)
		const ciphertext = combined.slice(12)
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertext,
		)
		return JSON.parse(dec.decode(plaintext)) as T
	} catch {
		return undefined
	}
}