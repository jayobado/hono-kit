/**
 * @module
 * Upstream HTTP client for BFFs. Builds requests with credentials, correlation
 * headers, and sensible JSON defaults. Provides both a low-level fetch and
 * typed convenience methods, plus a passthrough proxy for forwarding browser
 * requests to upstream services.
 *
 *   const upstream = createUpstream({
 *     baseUrl: 'http://internal-api',
 *     credentialFrom: auth.backendHeaders,
 *   })
 *
 *   // In a handler:
 *   const orders = await upstream.get<Order[]>(c, '/orders')
 *   // or:
 *   return await upstream.proxy(c, '/orders')
 */

import type { Context } from 'hono'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UpstreamOptions {
	baseUrl: string
	/** Returns headers to attach for upstream auth. Typically auth.backendHeaders. */
	credentialFrom?: (c: Context) => Record<string, string>
	/** Headers attached to every outbound request. */
	defaultHeaders?: Record<string, string>
	/** If set, forwards c.get('requestId') under this header name. */
	requestIdHeader?: string
	/** Abort outbound requests after this many ms. Default: off. */
	timeout?: number
	/**
	 * Headers to strip from incoming requests when proxying. The defaults
	 * cover hop-by-hop headers plus cookie, host, and authorization.
	 */
	stripHeaders?: string[]
}

export interface Upstream {
	headers(c: Context, extra?: Record<string, string>): Record<string, string>
	fetch(c: Context, path: string, init?: RequestInit): Promise<Response>
	get<T = unknown>(c: Context, path: string, init?: RequestInit): Promise<T>
	post<T = unknown>(c: Context, path: string, body?: unknown, init?: RequestInit): Promise<T>
	put<T = unknown>(c: Context, path: string, body?: unknown, init?: RequestInit): Promise<T>
	patch<T = unknown>(c: Context, path: string, body?: unknown, init?: RequestInit): Promise<T>
	delete<T = unknown>(c: Context, path: string, init?: RequestInit): Promise<T>
	proxy(c: Context, path?: string, init?: RequestInit): Promise<Response>
}

// ─── UpstreamError ───────────────────────────────────────────────────────────

export class UpstreamError extends Error {
	readonly status: number
	readonly statusText: string
	readonly body: unknown
	readonly response: Response

	constructor(response: Response, body: unknown) {
		super(`Upstream ${response.status} ${response.statusText}`)
		this.name = 'UpstreamError'
		this.status = response.status
		this.statusText = response.statusText
		this.body = body
		this.response = response
	}
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_STRIP_HEADERS = new Set([
	// Hop-by-hop (RFC 7230)
	'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
	'upgrade', 'proxy-authenticate', 'proxy-authorization',
	// BFF-specific
	'cookie', 'host', 'authorization',
	// Length recomputed by fetch
	'content-length',
])

// ─── createUpstream ──────────────────────────────────────────────────────────

export function createUpstream(opts: UpstreamOptions): Upstream {
	const baseUrl = opts.baseUrl.replace(/\/+$/, '')
	const stripHeaders = new Set([
		...DEFAULT_STRIP_HEADERS,
		...(opts.stripHeaders ?? []).map(h => h.toLowerCase()),
	])

	function buildUrl(path: string): string {
		if (/^https?:\/\//.test(path)) return path
		return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
	}

	function buildHeaders(c: Context, extra?: Record<string, string>): Record<string, string> {
		const headers: Record<string, string> = {
			...(opts.defaultHeaders ?? {}),
		}

		if (opts.credentialFrom) {
			Object.assign(headers, opts.credentialFrom(c))
		}

		if (opts.requestIdHeader) {
			const rid = c.get('requestId') as string | undefined
			if (rid) headers[opts.requestIdHeader] = rid
		}

		if (extra) Object.assign(headers, extra)

		return headers
	}

	function withTimeout(init?: RequestInit): RequestInit {
		if (!opts.timeout) return init ?? {}
		const timeoutSignal = AbortSignal.timeout(opts.timeout)
		if (init?.signal) {
			return { ...init, signal: AbortSignal.any([init.signal, timeoutSignal]) }
		}
		return { ...init, signal: timeoutSignal }
	}

	function doFetch(c: Context, path: string, init?: RequestInit): Promise<Response> {
		const headers = mergeHeaders(buildHeaders(c), init?.headers)
		return fetch(buildUrl(path), withTimeout({ ...init, headers }))
	}

	async function jsonRequest<T>(
		c: Context,
		method: string,
		path: string,
		body: unknown,
		init?: RequestInit,
	): Promise<T> {
		const hasBody = body !== undefined
		const headers = mergeHeaders(
			buildHeaders(c, hasBody ? { 'content-type': 'application/json' } : undefined),
			init?.headers,
		)
		const finalInit = withTimeout({
			...init,
			method,
			headers,
			body: hasBody ? JSON.stringify(body) : init?.body,
		})

		const res = await fetch(buildUrl(path), finalInit)

		if (!res.ok) {
			const errBody = await readBody(res)
			throw new UpstreamError(res, errBody)
		}

		if (res.status === 204) return undefined as T
		return await res.json() as T
	}

	return {
		headers: buildHeaders,

		fetch: doFetch,

		get<T>(c: Context, path: string, init?: RequestInit): Promise<T> {
			return jsonRequest<T>(c, 'GET', path, undefined, init)
		},
		post<T>(c: Context, path: string, body?: unknown, init?: RequestInit): Promise<T> {
			return jsonRequest<T>(c, 'POST', path, body, init)
		},
		put<T>(c: Context, path: string, body?: unknown, init?: RequestInit): Promise<T> {
			return jsonRequest<T>(c, 'PUT', path, body, init)
		},
		patch<T>(c: Context, path: string, body?: unknown, init?: RequestInit): Promise<T> {
			return jsonRequest<T>(c, 'PATCH', path, body, init)
		},
		delete<T>(c: Context, path: string, init?: RequestInit): Promise<T> {
			return jsonRequest<T>(c, 'DELETE', path, undefined, init)
		},

		proxy(c: Context, path?: string, init?: RequestInit): Promise<Response> {
			const req = c.req.raw
			const targetPath = path ?? new URL(req.url).pathname + new URL(req.url).search

			const forwardedHeaders: Record<string, string> = {}
			for (const [key, value] of req.headers) {
				if (!stripHeaders.has(key.toLowerCase())) {
					forwardedHeaders[key] = value
				}
			}

			const credentialHeaders = buildHeaders(c)
			Object.assign(forwardedHeaders, credentialHeaders)

			// Body: bodies can only be read once. For methods that have one,
			// pass the original stream through.
			const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

			return fetch(buildUrl(targetPath), withTimeout({
				method: req.method,
				headers: mergeHeaders(forwardedHeaders, init?.headers),
				body: hasBody ? req.body : undefined,
				// Required when forwarding a ReadableStream body in some runtimes.
				...(hasBody ? { duplex: 'half' } as RequestInit : {}),
				...init,
			}))
		},
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeHeaders(
	base: Record<string, string>,
	extra?: HeadersInit,
): Record<string, string> {
	if (!extra) return base
	const merged = { ...base }
	if (extra instanceof Headers) {
		for (const [k, v] of extra) merged[k] = v
	} else if (Array.isArray(extra)) {
		for (const [k, v] of extra) merged[k] = v
	} else {
		Object.assign(merged, extra)
	}
	return merged
}

async function readBody(res: Response): Promise<unknown> {
	const contentType = res.headers.get('content-type') ?? ''
	try {
		if (contentType.includes('application/json')) return await res.json()
		return await res.text()
	} catch {
		return undefined
	}
}