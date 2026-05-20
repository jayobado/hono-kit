/**
 * @module
 * Cloudflare Workers session stores. Imported separately to keep CF types
 * out of the main bundle:
 *
 *   import { createKvSessionStore } from '@jayobado/hono-kit/cf-stores'
 *
 * KV is eventually consistent and suitable for sessions that tolerate a small
 * read-after-write window. For strict consistency or active session
 * coordination, use createDurableObjectSessionStore instead.
 */

import type { SessionStore } from '../auth.ts'

// ─── Minimal Cloudflare ambient types ────────────────────────────────────────
// We declare only what we use, to avoid a hard dependency on @cloudflare/workers-types.

interface KVNamespace {
	get(key: string, type?: 'text' | 'json'): Promise<string | null>
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
	delete(key: string): Promise<void>
}

interface DurableObjectNamespace {
	idFromName(name: string): DurableObjectId
	get(id: DurableObjectId): DurableObjectStub
}
interface DurableObjectId { toString(): string }
interface DurableObjectStub {
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
}

// ─── KV-backed store ─────────────────────────────────────────────────────────

interface KvStoreOptions {
	prefix?: string
}

export function createKvSessionStore<T extends Record<string, unknown> = Record<string, unknown>>(
	kv: KVNamespace,
	opts: KvStoreOptions = {},
): SessionStore<T> {
	const prefix = opts.prefix ?? 'sess:'
	const key = (sid: string) => `${prefix}${sid}`

	return {
		async get(sid) {
			const raw = await kv.get(key(sid))
			if (!raw) return undefined
			try {
				return JSON.parse(raw) as T
			} catch {
				return undefined
			}
		},

		async set(sid, data, ttl) {
			await kv.put(
				key(sid),
				JSON.stringify(data),
				ttl ? { expirationTtl: ttl } : undefined,
			)
		},

		async delete(sid) {
			await kv.delete(key(sid))
		},

		async touch(sid, ttl) {
			if (!ttl) return
			// KV has no native touch; re-put to extend TTL.
			const raw = await kv.get(key(sid))
			if (!raw) return
			await kv.put(key(sid), raw, { expirationTtl: ttl })
		},
	}
}

// ─── Durable Object-backed store ─────────────────────────────────────────────
// Expects a DO that exposes GET / PUT / DELETE on /<sid> and respects
// expirationTtl via a header. A reference DO implementation is documented
// in recipes/cloudflare-do-session.md.

export function createDurableObjectSessionStore<T extends Record<string, unknown> = Record<string, unknown>>(
	ns: DurableObjectNamespace,
	objectName = 'sessions',
): SessionStore<T> {
	function stub(): DurableObjectStub {
		return ns.get(ns.idFromName(objectName))
	}

	return {
		async get(sid) {
			const res = await stub().fetch(`https://session/${encodeURIComponent(sid)}`, {
				method: 'GET',
			})
			if (res.status === 404) return undefined
			if (!res.ok) return undefined
			try {
				return await res.json() as T
			} catch {
				return undefined
			}
		},

		async set(sid, data, ttl) {
			await stub().fetch(`https://session/${encodeURIComponent(sid)}`, {
				method: 'PUT',
				headers: {
					'content-type': 'application/json',
					...(ttl ? { 'x-expiration-ttl': String(ttl) } : {}),
				},
				body: JSON.stringify(data),
			})
		},

		async delete(sid) {
			await stub().fetch(`https://session/${encodeURIComponent(sid)}`, {
				method: 'DELETE',
			})
		},

		async touch(sid, ttl) {
			if (!ttl) return
			await stub().fetch(`https://session/${encodeURIComponent(sid)}`, {
				method: 'PATCH',
				headers: { 'x-expiration-ttl': String(ttl) },
			})
		},
	}
}