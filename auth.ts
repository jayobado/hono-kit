import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { Context, MiddlewareHandler } from 'hono'
import type {
	SessionStore,
	CookieOptions,
	CredentialOptions,
} from './types.ts'

// ─── Auth options ─────────────────────────────────────────────────────────────

interface RefreshOptions<T> {
	isExpired: (session: T) => boolean
	renew: (session: T) => Promise<T>
}

interface AuthBase<T extends Record<string, unknown>> {
	cookie?: CookieOptions
	extract: (response: unknown) => T
	credential?: CredentialOptions<T>
	refresh?: RefreshOptions<T>
}

interface AuthWithStore<T extends Record<string, unknown>> extends AuthBase<T> {
	store: SessionStore<T>
	stateless?: never
}

interface AuthStateless<T extends Record<string, unknown>> extends AuthBase<T> {
	store?: never
	stateless: { secret: string }
}

export type AuthOptions<T extends Record<string, unknown>> =
	| AuthWithStore<T>
	| AuthStateless<T>

// ─── Memory store ─────────────────────────────────────────────────────────────

interface StoreEntry<T> {
	data: T
	expiresAt?: number
}

export function createMemoryStore<T extends Record<string, unknown> = Record<string, unknown>>(): SessionStore<T> {
	const store = new Map<string, StoreEntry<T>>()

	function isExpired(entry: StoreEntry<T>): boolean {
		return entry.expiresAt !== undefined && Date.now() > entry.expiresAt
	}
	let cleanupTimer: ReturnType<typeof setInterval> | undefined

	function startCleanup(): void {
		if (cleanupTimer) return
		const timer = setInterval(() => {
			for (const [sid, entry] of store) {
				if (isExpired(entry)) store.delete(sid)
			}
			if (store.size === 0 && cleanupTimer) {
				clearInterval(cleanupTimer)
				cleanupTimer = undefined
			}
		}, 60_000)

		// Prevent timer from keeping the process alive
		if (typeof timer === 'object' && 'unref' in timer) {
			(timer as { unref: () => void }).unref()
		}

		cleanupTimer = timer
	}
	
	return {
		get(sid) {
			const entry = store.get(sid)
			if (!entry) return Promise.resolve(undefined)
			if (isExpired(entry)) {
				store.delete(sid)
				return Promise.resolve(undefined)
			}
			return Promise.resolve(entry.data)
		},

		set(sid, data, ttl) {
			store.set(sid, {
				data,
				expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
			})
			startCleanup()
			return Promise.resolve()
		},

		delete(sid) {
			store.delete(sid)
			return Promise.resolve()
		},

		touch(sid, ttl) {
			const entry = store.get(sid)
			if (!entry) return Promise.resolve()
			if (ttl) entry.expiresAt = Date.now() + ttl * 1000
			return Promise.resolve()
		},
	}
}

// ─── Session middleware ───────────────────────────────────────────────────────

export function createSessionMiddleware<T extends Record<string, unknown>>(
	store: SessionStore<T>,
	cookie?: CookieOptions,
): MiddlewareHandler {
	const cookieName = cookie?.name ?? 'sid'

	return createMiddleware(async (c, next) => {
		const sid = getCookie(c, cookieName)
		if (sid) {
			const session = await store.get(sid)
			c.set('session', session ?? undefined)
		} else {
			c.set('session', undefined)
		}
		await next()
	})
}

// ─── Cookie defaults ──────────────────────────────────────────────────────────

function resolveCookieOptions(opts?: CookieOptions): Required<CookieOptions> {
	return {
		name: opts?.name ?? 'sid',
		maxAge: opts?.maxAge ?? 60 * 60 * 24 * 7,
		secure: opts?.secure ?? true,
		sameSite: opts?.sameSite ?? 'Lax',
		httpOnly: opts?.httpOnly ?? true,
		path: opts?.path ?? '/',
	}
}

export interface Auth<T extends Record<string, unknown>> {
	login: (c: Context, backendResponse: unknown) => Promise<T>
	logout: (c: Context) => Promise<void>
	middleware: () => MiddlewareHandler
	getSession: (c: Context) => T | undefined
	getToken: (c: Context) => string | undefined
	backendHeaders: (c: Context) => Record<string, string>
	require: () => MiddlewareHandler
	requireRole: (check: (session: T) => boolean, message?: string) => MiddlewareHandler
}

// ─── createAuth ───────────────────────────────────────────────────────────────

export function createAuth<T extends Record<string, unknown>>(opts: AuthOptions<T>): Auth<T> {
	const cookie = resolveCookieOptions(opts.cookie)
	const isStateless = 'stateless' in opts && opts.stateless !== undefined

	return {
		// ── Login ─────────────────────────────────────────────────────────

		async login(c: Context, backendResponse: unknown): Promise<T> {
			const session = opts.extract(backendResponse)

			if (isStateless) {
				const encrypted = await encrypt(session, opts.stateless!.secret)
				setCookie(c, cookie.name, encrypted, {
					httpOnly: cookie.httpOnly,
					secure: cookie.secure,
					sameSite: cookie.sameSite,
					path: cookie.path,
					maxAge: cookie.maxAge,
				})
			} else {
				const sid = crypto.randomUUID()
				await opts.store!.set(sid, session, cookie.maxAge)
				setCookie(c, cookie.name, sid, {
					httpOnly: cookie.httpOnly,
					secure: cookie.secure,
					sameSite: cookie.sameSite,
					path: cookie.path,
					maxAge: cookie.maxAge,
				})
			}

			return session
		},

		// ── Logout ────────────────────────────────────────────────────────

		async logout(c: Context): Promise<void> {
			const sid = getCookie(c, cookie.name)
			if (sid && !isStateless) {
				await opts.store!.delete(sid)
			}
			deleteCookie(c, cookie.name, { path: cookie.path })
		},

		// ── Middleware ────────────────────────────────────────────────────

		middleware(): MiddlewareHandler {
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

				// Auto-refresh expired tokens
				if (opts.refresh && opts.refresh.isExpired(session)) {
					try {
						session = await opts.refresh.renew(session)

						if (isStateless) {
							const encrypted = await encrypt(session, opts.stateless!.secret)
							setCookie(c, cookie.name, encrypted, {
								httpOnly: cookie.httpOnly,
								secure: cookie.secure,
								sameSite: cookie.sameSite,
								path: cookie.path,
								maxAge: cookie.maxAge,
							})
						} else {
							await opts.store!.set(value, session, cookie.maxAge)
						}
					} catch {
						if (!isStateless) await opts.store!.delete(value)
						deleteCookie(c, cookie.name, { path: cookie.path })
						c.set('session', undefined)
						return next()
					}
				}

				// Extend TTL on activity
				if (!isStateless && opts.store!.touch) {
					await opts.store!.touch(value, cookie.maxAge)
				}

				c.set('session', session)
				await next()
			})
		},

		// ── Get session ───────────────────────────────────────────────────

		getSession(c: Context): T | undefined {
			return c.get('session') as T | undefined
		},

		// ── Get backend token ─────────────────────────────────────────────

		getToken(c: Context): string | undefined {
			const session = c.get('session') as T | undefined
			if (!session || !opts.credential) return undefined
			return session[opts.credential.field] as string | undefined
		},

		// ── Backend request headers ───────────────────────────────────────

		backendHeaders(c: Context): Record<string, string> {
			const session = c.get('session') as T | undefined
			if (!session || !opts.credential) return {}

			const value = session[opts.credential.field]
			if (typeof value !== 'string' || !value) return {}

			const header = opts.credential.header ?? 'Authorization'
			const format = opts.credential.format ?? ((v: string) => `Bearer ${v}`)

			return { [header]: format(value) }
		},

		// ── Require auth guard ────────────────────────────────────────────

		require(): MiddlewareHandler {
			return createMiddleware(async (c, next) => {
				const session = c.get('session') as T | undefined
				if (!session) {
					return c.json({ message: 'Unauthorized', code: 401 }, 401)
				}
				await next()
			})
		},

		// ── Role guard ────────────────────────────────────────────────────

		requireRole(
			check: (session: T) => boolean,
			message?: string,
		): MiddlewareHandler {
			return createMiddleware(async (c, next) => {
				const session = c.get('session') as T | undefined
				if (!session) {
					return c.json({ message: 'Unauthorized', code: 401 }, 401)
				}
				if (!check(session)) {
					return c.json({ message: message ?? 'Forbidden', code: 403 }, 403)
				}
				await next()
			})
		},
	}
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

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
		const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4)
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