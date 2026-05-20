/**
 * @module
 * Dev-mode SPA serving with lazy transpile and HMR. For local development
 * with TS/JSX source files served straight from disk. Deno-only.
 *
 *   const dev = createDevServer({ root: './client', importMap: './deno.json' })
 *   app.route('/', dev.app)
 *   // ...later, on shutdown:
 *   dev.dispose()
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
	createTranspiler,
	loadImportMap,
	buildRewriteMap,
	rewriteImports,
	toTranspileSpecifier,
} from './internal/transpiler.ts'
import { mimeFor } from './internal/mime.ts'
import { hashCode, shouldTranspile, isSpaRoute } from './internal/paths.ts'
import { createHmr, injectHmrClient, watchFs } from './hmr.ts'
import { Log } from '../logger.ts'

export interface DevServerOptions {
	root: string
	importMap?: string | { imports: Record<string, string> }
	compilerOptions?: Record<string, unknown>
	hmrPath?: string
	watch?: boolean
}

export interface DevServer {
	app: Hono
	dispose(): void
}

export function createDevServer(opts: DevServerOptions): DevServer {
	const root = opts.root.replace(/\/+$/, '')
	const hmrPath = opts.hmrPath ?? '/__hmr'
	const watch = opts.watch !== false

	const app = new Hono()
	const transpiler = createTranspiler()
	const hmr = createHmr({ path: hmrPath })

	let rewritesPromise: Promise<Map<string, string>> | undefined
	async function getRewrites(): Promise<Map<string, string>> {
		if (!rewritesPromise) {
			rewritesPromise = (async () => {
				const imports = await loadImportMap(opts.importMap)
				return buildRewriteMap(imports, opts.importMap)
			})()
		}
		return rewritesPromise
	}

	app.get(hmrPath, (c) => hmr.handler(c))

	const stopWatcher = watch
		? watchFs(root, (event) => {
			for (const path of event.paths) {
				if (path.endsWith('.css')) {
					hmr.broadcast({ type: 'css', path })
				} else {
					transpiler.invalidate(path)
					hmr.broadcast({ type: 'reload', path })
				}
			}
		})
		: () => { /* noop */ }

	async function serveTranspiled(c: Context, pathname: string): Promise<Response> {
		const specifier = toTranspileSpecifier(pathname, root)
		const rewrites = await getRewrites()

		let code = await transpiler.transpile(specifier, {
			importMap: opts.importMap,
			compilerOptions: opts.compilerOptions,
		})
		if (!code) return c.text('File not found', 404)

		code = rewriteImports(code, rewrites)
		const isVersioned = pathname.startsWith('/jsr/') || pathname.startsWith('/npm/')
		const etag = `"${hashCode(code)}"`

		if (c.req.header('if-none-match') === etag) {
			return new Response(null, { status: 304, headers: { ETag: etag } })
		}

		return new Response(code, {
			headers: {
				'Content-Type': 'application/javascript; charset=utf-8',
				'Cache-Control': isVersioned ? 'public, max-age=31536000, immutable' : 'no-cache',
				'ETag': etag,
			},
		})
	}

	async function serveStatic(c: Context, pathname: string): Promise<Response | undefined> {
		const mime = mimeFor(pathname)
		if (!mime) return undefined

		const filePath = `${root}${pathname}`
		try {
			const bytes = await Deno.readFile(filePath)

			if (pathname.endsWith('.html')) {
				const html = injectHmrClient(new TextDecoder().decode(bytes), hmrPath)
				return new Response(html, { headers: { 'Content-Type': mime } })
			}

			return new Response(bytes as BufferSource, { headers: { 'Content-Type': mime } })
		} catch {
			return undefined
		}
	}

	app.get('*', async (c) => {
		const url = new URL(c.req.url)
		const pathname = url.pathname

		if (pathname === hmrPath) return c.text('Not Found', 404)

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
				const html = injectHmrClient(new TextDecoder().decode(bytes), hmrPath)
				return new Response(html, {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				})
			} catch {
				return c.text('Not Found', 404)
			}
		}

		return c.text('Not Found', 404)
	})

	Log.info(`[spa:dev] serving ${root} (hmr=${watch ? 'on' : 'off'})`)

	return {
		app,
		dispose() {
			stopWatcher()
			hmr.dispose()
		},
	}
}