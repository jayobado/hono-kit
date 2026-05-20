/**
 * @module
 * Build-mode SPA serving. Reads pre-built static files from a directory and
 * serves them with appropriate cache headers. If a manifest is provided,
 * substitutes hashed filenames into index.html at serve time.
 *
 * Runtime-agnostic: works on Deno, Node, and Cloudflare Workers (when the
 * assets are bundled into the worker via Workers Sites / Assets binding).
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { mimeFor, isCompressible } from './internal/mime.ts'
import { hashCode, isSpaRoute } from './internal/paths.ts'

export interface AssetManifest {
	[entry: string]: string
}

export interface ServeAssetsOptions {
	root: string
	manifest?: AssetManifest
	indexHtml?: string
	immutableCacheControl?: string
	defaultCacheControl?: string
	readBinary?(path: string): Promise<Uint8Array>
}

function defaultReader(): (path: string) => Promise<Uint8Array> {
	// deno-lint-ignore no-explicit-any
	const g = globalThis as any
	if (typeof g.Deno !== 'undefined') {
		return (path: string) => g.Deno.readFile(path) as Promise<Uint8Array>
	}
	throw new Error('serveAssets: no default file reader available; pass readBinary option')
}

function substituteAssets(html: string, manifest: AssetManifest): string {
	return html.replace(/__ASSET\(["']([^"']+)["']\)__/g, (_, name: string) => {
		const hashed = manifest[name]
		return hashed ? `/${hashed}` : `/${name}`
	})
}

function isHashed(pathname: string): boolean {
	const base = pathname.split('/').pop() ?? ''
	return /\.[a-f0-9]{8,}\.[a-zA-Z0-9]+$/.test(base)
}

export function serveAssets(opts: ServeAssetsOptions): Hono {
	const app = new Hono()
	const root = opts.root.replace(/\/+$/, '')
	const indexHtml = opts.indexHtml ?? 'index.html'
	const immutableCache = opts.immutableCacheControl ?? 'public, max-age=31536000, immutable'
	const defaultCache = opts.defaultCacheControl ?? 'no-cache'
	const readBinary = opts.readBinary ?? defaultReader()

	let indexCache: { body: string; etag: string } | undefined

	async function loadIndex(): Promise<{ body: string; etag: string }> {
		if (indexCache) return indexCache
		const bytes = await readBinary(`${root}/${indexHtml}`)
		let body = new TextDecoder().decode(bytes)
		if (opts.manifest) body = substituteAssets(body, opts.manifest)
		const etag = `"${hashCode(body)}"`
		indexCache = { body, etag }
		return indexCache
	}

	async function serveFile(c: Context, pathname: string): Promise<Response | undefined> {
		const mime = mimeFor(pathname)
		if (!mime) return undefined

		try {
			const bytes = await readBinary(`${root}${pathname}`)
			const etag = `"${hashCode(String(bytes.byteLength) + ':' + pathname)}"`

			if (c.req.header('if-none-match') === etag) {
				return new Response(null, { status: 304, headers: { ETag: etag } })
			}

			return new Response(bytes as BufferSource, {
				headers: {
					'Content-Type': mime,
					'Cache-Control': isHashed(pathname) ? immutableCache : defaultCache,
					'ETag': etag,
					...(isCompressible(mime) ? { Vary: 'Accept-Encoding' } : {}),
				},
			})
		} catch {
			return undefined
		}
	}

	app.get('*', async (c) => {
		const url = new URL(c.req.url)
		const pathname = url.pathname

		if (pathname.includes('.') && pathname !== `/${indexHtml}`) {
			const res = await serveFile(c, pathname)
			if (res) return res
		}

		if (isSpaRoute(pathname) || pathname === '/' || pathname === `/${indexHtml}`) {
			const { body, etag } = await loadIndex()
			if (c.req.header('if-none-match') === etag) {
				return new Response(null, { status: 304, headers: { ETag: etag } })
			}
			return new Response(body, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': defaultCache,
					'ETag': etag,
				},
			})
		}

		return c.text('Not Found', 404)
	})

	return app
}