/**
 * @module
 * Transpile-mode SPA serving. For VPS deployments where you want to ship
 * source without running a build step. Eagerly transpiles + gzips everything
 * at startup, then serves with strong cache headers. No HMR, no watcher.
 *
 * Deno-only (same constraint as dev mode — uses @deno/emit).
 *
 *   const server = await createTranspileServer({
 *     root: './client',
 *     importMap: './deno.json',
 *   })
 *   app.route('/', server.app)
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
	createTranspiler,
	loadImportMap,
	buildRewriteMap,
	rewriteImports,
	toTranspileSpecifier,
	toFileUrl,
} from './internal/transpiler.ts'
import { mimeFor, isCompressible } from './internal/mime.ts'
import { hashCode, shouldTranspile, isSpaRoute } from './internal/paths.ts'
import { Log } from '../logger.ts'

export interface TranspileServerOptions {
	root: string
	importMap?: string | { imports: Record<string, string> }
	compilerOptions?: Record<string, unknown>
	pregzip?: boolean
}

export interface TranspileServer {
	app: Hono
	warmedCount: number
	warmedIn: number
}

interface ServedEntry {
	code: string
	gzipped?: Uint8Array
	etag: string
}

async function gzip(data: string): Promise<Uint8Array> {
	const encoded = new TextEncoder().encode(data)
	const stream = new Blob([encoded as BufferSource]).stream()
		.pipeThrough(new CompressionStream('gzip'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function createTranspileServer(
	opts: TranspileServerOptions,
): Promise<TranspileServer> {
	const root = opts.root.replace(/\/+$/, '')
	const pregzip = opts.pregzip !== false

	const app = new Hono()
	const transpiler = createTranspiler()
	const imports = await loadImportMap(opts.importMap)
	const rewrites = await buildRewriteMap(imports, opts.importMap)

	const served = new Map<string, ServedEntry>()

	const warmStart = performance.now()
	const warmedCount = await transpiler.warm(root, {
		importMap: opts.importMap,
		compilerOptions: opts.compilerOptions,
	})

	for (const [specifier, raw] of transpiler.entries()) {
		const code = rewriteImports(raw, rewrites)
		const entry: ServedEntry = { code, etag: `"${hashCode(code)}"` }
		if (pregzip) entry.gzipped = await gzip(code)
		served.set(specifier, entry)
	}

	const warmedIn = Math.round(performance.now() - warmStart)
	Log.info(
		`[spa:transpile] warmed ${warmedCount} modules in ${warmedIn}ms` +
		(pregzip ? ' (pre-gzipped)' : ''),
	)

	async function serveTranspiled(c: Context, pathname: string): Promise<Response> {
		const specifier = toTranspileSpecifier(pathname, root)

		let entry = served.get(specifier)
		if (!entry) {
			let code = await transpiler.transpile(specifier, {
				importMap: opts.importMap,
				compilerOptions: opts.compilerOptions,
			})
			if (!code) return c.text('File not found', 404)
			code = rewriteImports(code, rewrites)
			entry = { code, etag: `"${hashCode(code)}"` }
			if (pregzip) entry.gzipped = await gzip(code)
			served.set(specifier, entry)
		}

		const isVersioned = pathname.startsWith('/jsr/') || pathname.startsWith('/npm/')
		const cacheControl = isVersioned
			? 'public, max-age=31536000, immutable'
			: 'public, max-age=300'

		if (c.req.header('if-none-match') === entry.etag) {
			return new Response(null, { status: 304, headers: { ETag: entry.etag } })
		}

		const acceptsGzip = (c.req.header('accept-encoding') ?? '').includes('gzip')
		if (entry.gzipped && acceptsGzip) {
			return new Response(entry.gzipped as BufferSource, {
				headers: {
					'Content-Type': 'application/javascript; charset=utf-8',
					'Content-Encoding': 'gzip',
					'Cache-Control': cacheControl,
					'ETag': entry.etag,
					'Vary': 'Accept-Encoding',
				},
			})
		}

		return new Response(entry.code, {
			headers: {
				'Content-Type': 'application/javascript; charset=utf-8',
				'Cache-Control': cacheControl,
				'ETag': entry.etag,
				'Vary': 'Accept-Encoding',
			},
		})
	}

	async function serveStatic(c: Context, pathname: string): Promise<Response | undefined> {
		const mime = mimeFor(pathname)
		if (!mime) return undefined

		try {
			const bytes = await Deno.readFile(`${root}${pathname}`)
			const etag = `"${hashCode(toFileUrl(`${root}${pathname}`) + ':' + bytes.byteLength)}"`

			if (c.req.header('if-none-match') === etag) {
				return new Response(null, { status: 304, headers: { ETag: etag } })
			}

			return new Response(bytes as BufferSource, {
				headers: {
					'Content-Type': mime,
					'Cache-Control': 'public, max-age=300',
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

		if (shouldTranspile(pathname)) {
			return serveTranspiled(c, pathname)
		}

		if (pathname.includes('.')) {
			const res = await serveStatic(c, pathname)
			if (res) return res
		}

		if (isSpaRoute(pathname) || pathname === '/') {
			try {
				const bytes = await Deno.readFile(`${root}/index.html`)
				return new Response(bytes as BufferSource, {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				})
			} catch {
				return c.text('Not Found', 404)
			}
		}

		return c.text('Not Found', 404)
	})

	return { app, warmedCount, warmedIn }
}