/**
 * @module
 * In-process session store. Suitable for single-instance VPS deployments.
 * For Cloudflare Workers, use createKvSessionStore or
 * createDurableObjectSessionStore from @jayobado/hono-kit/cf-stores.
 */

import type { SessionStore } from '../auth.ts'

interface Entry<T> {
	data: T
	expiresAt?: number
}

interface MemoryStoreOptions {
	/** Cleanup interval in ms. Defaults to 60_000. Set to 0 to disable. */
	cleanupInterval?: number
}

export function createMemoryStore<T extends Record<string, unknown> = Record<string, unknown>>(
	opts: MemoryStoreOptions = {},
): SessionStore<T> & { dispose(): void } {
	const store = new Map<string, Entry<T>>()
	const cleanupInterval = opts.cleanupInterval ?? 60_000
	let timer: ReturnType<typeof setInterval> | undefined

	function isExpired(entry: Entry<T>): boolean {
		return entry.expiresAt !== undefined && Date.now() > entry.expiresAt
	}

	function startCleanup(): void {
		if (timer || cleanupInterval <= 0) return
		const t = setInterval(() => {
			for (const [sid, entry] of store) {
				if (isExpired(entry)) store.delete(sid)
			}
			if (store.size === 0 && timer) {
				clearInterval(timer)
				timer = undefined
			}
		}, cleanupInterval)

		// Don't keep the process alive on this timer alone.
		if (typeof t === 'object' && t !== null && 'unref' in t) {
			(t as { unref: () => void }).unref()
		}
		timer = t
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

		dispose() {
			if (timer) {
				clearInterval(timer)
				timer = undefined
			}
			store.clear()
		},
	}
}