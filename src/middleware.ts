import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import { Log } from './logger.ts'

/** Assigns a request ID to each request. Forwards incoming X-Request-ID or X-Correlation-ID
 * if present; otherwise generates a new UUID. Sets X-Request-ID on the response. */
export function requestId(): MiddlewareHandler {
	return createMiddleware(async (c, next) => {
		const incoming =
			c.req.header('x-request-id') ??
			c.req.header('x-correlation-id') ??
			crypto.randomUUID()
		c.set('requestId', incoming)
		c.header('X-Request-ID', incoming)
		await next()
	})
}

/** Catches unhandled errors, logs them, and returns a 500 JSON response. */
export function errorHandler(): MiddlewareHandler {
	return createMiddleware(async (c, next) => {
		try {
			await next()
		} catch (err) {
			const rid = c.get('requestId') ?? '-'
			const message = err instanceof Error ? err.message : String(err)
			Log.error(`[${rid}] Unhandled error: ${message}`)
			return c.json({ message: 'Internal server error', code: 500 }, 500)
		}
	})
}

/** Sets security headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. */
export function securityHeaders(): MiddlewareHandler {
	return createMiddleware(async (c, next) => {
		await next()
		c.header('X-Content-Type-Options', 'nosniff')
		c.header('X-Frame-Options', 'DENY')
		c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
		c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
	})
}

export interface AccessLogOptions {
	/** Output format. 'text' for human-readable, 'json' for structured logging. Default: 'text'. */
	format?: 'text' | 'json'
}

/** Logs method, path, status, and duration for each request. */
export function accessLog(opts: AccessLogOptions = {}): MiddlewareHandler {
	const format = opts.format ?? 'text'

	return createMiddleware(async (c, next) => {
		const start = performance.now()
		await next()
		const ms = (performance.now() - start).toFixed(1)
		const method = c.req.method
		const path = new URL(c.req.url).pathname
		const status = c.res.status
		const rid = c.get('requestId') ?? '-'

		const line = format === 'json'
			? JSON.stringify({ rid, method, path, status, ms: parseFloat(ms) })
			: `[${rid}] ${method} ${path} ${status} ${ms}ms`

		if (status >= 500) {
			Log.error(line)
		} else if (status >= 400) {
			Log.warn(line)
		} else {
			Log.info(line)
		}
	})
}

/** Gzip compresses text-based responses (HTML, JS, JSON, SVG). */
export function compress(): MiddlewareHandler {
	return createMiddleware(async (c, next) => {
		await next()

		const contentType = c.res.headers.get('content-type') ?? ''
		const compressible =
			contentType.includes('text/') ||
			contentType.includes('application/javascript') ||
			contentType.includes('application/json') ||
			contentType.includes('image/svg+xml')

		if (!compressible || !c.res.body) return

		const encoded = c.res.body.pipeThrough(new CompressionStream('gzip'))
		const headers = new Headers(c.res.headers)
		headers.set('Content-Encoding', 'gzip')
		headers.delete('Content-Length')

		c.res = new Response(encoded, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		})
	})
}