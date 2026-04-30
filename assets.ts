import type { Hono } from 'hono'
import type { AssetsOptions } from './types.ts'

// ─── MIME types ───────────────────────────────────────────────────────────────

const mimeTypes: Record<string, string> = {
	'html': 'text/html; charset=utf-8',
	'css': 'text/css; charset=utf-8',
	'js': 'application/javascript; charset=utf-8',
	'mjs': 'application/javascript; charset=utf-8',
	'json': 'application/json; charset=utf-8',
	'svg': 'image/svg+xml',
	'png': 'image/png',
	'jpg': 'image/jpeg',
	'jpeg': 'image/jpeg',
	'gif': 'image/gif',
	'webp': 'image/webp',
	'avif': 'image/avif',
	'ico': 'image/x-icon',
	'woff': 'font/woff',
	'woff2': 'font/woff2',
	'ttf': 'font/ttf',
	'eot': 'application/vnd.ms-fontobject',
	'otf': 'font/otf',
	'mp4': 'video/mp4',
	'webm': 'video/webm',
	'mp3': 'audio/mpeg',
	'wav': 'audio/wav',
	'pdf': 'application/pdf',
	'txt': 'text/plain; charset=utf-8',
	'xml': 'application/xml',
	'wasm': 'application/wasm',
	'map': 'application/json',
}

function isTextType(mime: string): boolean {
	return mime.includes('text/') ||
		mime.includes('javascript') ||
		mime.includes('json') ||
		mime.includes('xml') ||
		mime.includes('svg')
}

// ─── mountAssets ──────────────────────────────────────────────────────────────

export function mountAssets(app: Hono, opts: AssetsOptions): void {
	const { root, prefix = '/', maxAge = 60 * 60 * 24 } = opts
	const pattern = prefix.endsWith('/') ? `${prefix}*` : `${prefix}/*`

	app.get(pattern, async (c) => {
		const url = new URL(c.req.url)
		const relativePath = prefix === '/'
			? url.pathname
			: url.pathname.slice(prefix.length)

		const filePath = `${root}${relativePath}`
		const ext = relativePath.split('.').pop()?.toLowerCase()

		if (!ext || !mimeTypes[ext]) {
			return c.text('Not Found', 404)
		}

		const mime = mimeTypes[ext]
		const cacheControl = `public, max-age=${maxAge}`

		// deno-lint-ignore no-explicit-any
		const g = globalThis as any

		try {
			if (isTextType(mime)) {
				if (typeof g.Deno !== 'undefined') {
					const content = await g.Deno.readTextFile(filePath)
					return new Response(content, {
						headers: {
							'Content-Type': mime,
							'Cache-Control': cacheControl,
						},
					})
				}
			} else {
				if (typeof g.Deno !== 'undefined') {
					const content = await g.Deno.readFile(filePath)
					return new Response(content.buffer as ArrayBuffer, {
						headers: {
							'Content-Type': mime,
							'Cache-Control': cacheControl,
						},
					})
				}
			}
		} catch {
			return c.text('Not Found', 404)
		}

		return c.text('Not Found', 404)
	})
}