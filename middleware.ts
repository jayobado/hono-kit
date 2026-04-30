import { createMiddleware } from 'hono/factory'
import { Log } from './logger.ts'

// ─── Request ID ───────────────────────────────────────────────────────────────

export function requestId() {
	return createMiddleware(async (c, next) => {
		c.set('requestId', crypto.randomUUID())
		await next()
	})
}

// ─── Error handler ────────────────────────────────────────────────────────────

export function errorHandler() {
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

// ─── Security headers ────────────────────────────────────────────────────────

export function securityHeaders() {
	return createMiddleware(async (c, next) => {
		await next()
		c.header('X-Content-Type-Options', 'nosniff')
		c.header('X-Frame-Options', 'DENY')
		c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
		c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
	})
}

// ─── Access log ───────────────────────────────────────────────────────────────

export function accessLog() {
	return createMiddleware(async (c, next) => {
		const start = performance.now()
		await next()
		const ms = (performance.now() - start).toFixed(1)
		const method = c.req.method
		const path = new URL(c.req.url).pathname
		const status = c.res.status
		const line = `${method} ${path} ${status} ${ms}ms`

		if (status >= 500) {
			Log.error(line)
		} else if (status >= 400) {
			Log.warn(line)
		} else {
			Log.info(line)
		}
	})
}

// ─── Compression ──────────────────────────────────────────────────────────────

export function compress() {
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