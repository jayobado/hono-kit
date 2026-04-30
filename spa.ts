import type { Hono } from 'hono'
import type { SpaOptions, RuntimeAdapter } from './types.ts'
import { Log } from './logger.ts'
import {
	createDenoTranspiler,
	loadImportMap,
	buildRewriteMap,
	rewriteImports,
	resolveRequestPath,
	hashCode,
	invalidateCache,
} from './transpile.ts'

// ─── HMR client script ───────────────────────────────────────────────────────

const hmrClientScript = `
	<script>
		(function() {
			const ws = new WebSocket('ws://' + location.host + '/__hmr');
			ws.onmessage = function(e) {
				const msg = JSON.parse(e.data);
				if (msg.type === 'reload') location.reload();
				if (msg.type === 'css') {
					document.querySelectorAll('link[rel=stylesheet]').forEach(function(l) {
						l.href = l.href.replace(/\\?.*$/, '') + '?t=' + Date.now();
					});
				}
			};
			ws.onclose = function() {
				setTimeout(function() { location.reload(); }, 1000);
			};
		})();
	</script>
`

function injectHmr(html: string): string {
	if (html.includes('</body>')) {
		return html.replace('</body>', `${hmrClientScript}</body>`)
	}
	return html + hmrClientScript
}

// ─── HMR WebSocket ───────────────────────────────────────────────────────────

const hmrClients = new Set<WebSocket>()

function broadcast(data: { type: string; path?: string }): void {
	const msg = JSON.stringify(data)
	for (const ws of hmrClients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(msg)
		}
	}
}

async function watchFs(root: string): Promise<void> {
	try {
		const watcher = Deno.watchFs(root)
		Log.info('[hmr] watching for file changes...')

		for await (const event of watcher) {
			if (event.kind !== 'modify' && event.kind !== 'create') continue

			for (const path of event.paths) {
				if (path.endsWith('.css')) {
					broadcast({ type: 'css', path })
				} else {
					invalidateCache(path)
					broadcast({ type: 'reload', path })
				}
			}
		}
	} catch (err) {
		Log.error(`[hmr] watcher error: ${err}`)
	}
}

// ─── mountSpa ─────────────────────────────────────────────────────────────────

export async function mountSpa(
	app: Hono,
	opts: SpaOptions,
	adapter: RuntimeAdapter,
): Promise<void> {
	const {
		root: fsRoot = './client',
		importMap,
		strategy = 'lazy',
		compilerOptions,
	} = opts

	const hmrEnabled = opts.hmr ?? (strategy === 'lazy')

	// ── Resolve import map and build rewrite map ──────────────────────────

	const imports = await loadImportMap(importMap, adapter)
	const rewrites = await buildRewriteMap(imports, importMap, adapter)

	// ── Create transpiler ─────────────────────────────────────────────────

	const transpiler = adapter.createTranspiler
		? adapter.createTranspiler()
		: createDenoTranspiler()

	// ── Eager warm ────────────────────────────────────────────────────────

	if (strategy === 'eager' && transpiler.warm) {
		Log.info('Warming transpile cache...')
		const start = performance.now()
		const count = await transpiler.warm(fsRoot, { importMap, compilerOptions })
		const elapsed = ((performance.now() - start) / 1000).toFixed(2)
		Log.info(`Transpile cache ready — ${count} files in ${elapsed}s`)
	}

	// ── HMR endpoint ──────────────────────────────────────────────────────

	if (hmrEnabled) {
		app.get('/__hmr', (c) => {
			const { response, socket } = Deno.upgradeWebSocket(c.req.raw)
			socket.onopen = () => hmrClients.add(socket)
			socket.onclose = () => hmrClients.delete(socket)
			socket.onerror = () => hmrClients.delete(socket)
			return response
		})

		watchFs(fsRoot).catch(err => {
			Log.error(`[hmr] watcher error: ${err}`)
		})
	}

	// ── Transpile handler ─────────────────────────────────────────────────

	async function handleTranspile(pathname: string): Promise<Response | null> {
		const path = resolveRequestPath(pathname, fsRoot)
		const isVersioned = pathname.startsWith('/jsr/') || pathname.startsWith('/npm/')

		try {
			let code = await transpiler.transpile(path, { importMap, compilerOptions })
			if (!code) return null

			code = rewriteImports(code, rewrites)

			return new Response(code, {
				headers: {
					'Content-Type': 'application/javascript; charset=utf-8',
					'Cache-Control': isVersioned
						? 'public, max-age=31536000, immutable'
						: 'no-cache',
					'ETag': `"${hashCode(code)}"`,
				},
			})
		} catch {
			return null
		}
	}

	// ── Catch-all route ───────────────────────────────────────────────────

	app.get('*', async (c) => {
		const url = new URL(c.req.url)

		// ── Transpile .ts/.tsx and dependency requests ────────────────────
		if (
			url.pathname.endsWith('.ts') ||
			url.pathname.endsWith('.tsx') ||
			url.pathname.startsWith('/jsr/') ||
			url.pathname.startsWith('/npm/')
		) {
			const response = await handleTranspile(url.pathname)
			if (response) return response
			return c.text('File not found', 404)
		}

		// ── Static files ─────────────────────────────────────────────────
		const ext = url.pathname.split('.').pop()?.toLowerCase()

		if (ext && staticMimeTypes[ext]) {
			const filePath = `${fsRoot}${url.pathname}`
			const isText = staticMimeTypes[ext].includes('text/') ||
				staticMimeTypes[ext].includes('javascript') ||
				staticMimeTypes[ext].includes('json') ||
				staticMimeTypes[ext].includes('xml') ||
				staticMimeTypes[ext].includes('svg')

			try {
				if (isText && adapter.readFile) {
					const content = await adapter.readFile(filePath)
					if (ext === 'html' && hmrEnabled) {
						return c.html(injectHmr(content))
					}
					return new Response(content, {
						headers: { 'Content-Type': staticMimeTypes[ext] },
					})
				}

				if (!isText && adapter.readBinary) {
					const content = await adapter.readBinary(filePath)
					return new Response(content.buffer as ArrayBuffer, {
						headers: { 'Content-Type': staticMimeTypes[ext] },
					})
				}
			} catch {
				// File not found — fall through
			}
		}

		// ── Deno serveDir fallback ────────────────────────────────────────
		if (adapter.name === 'deno') {
			const { serveDir } = await import('@std/http/file-server')

			const response = await serveDir(c.req.raw, {
				fsRoot,
				urlRoot: '',
				quiet: true,
			})

			if (response.status === 200) {
				if (
					hmrEnabled &&
					(response.headers.get('content-type') ?? '').includes('text/html')
				) {
					const html = await response.text()
					return c.html(injectHmr(html))
				}
				return response
			}
		}

		// ── SPA fallback — serve index.html for client-side routes ────────
		if (!url.pathname.includes('.')) {
			const indexPath = `${fsRoot}/index.html`

			if (adapter.readFile) {
				try {
					const html = await adapter.readFile(indexPath)
					return c.html(hmrEnabled ? injectHmr(html) : html)
				} catch {
					return c.text('Not Found', 404)
				}
			}

			if (adapter.name === 'deno') {
				const { serveFile } = await import('@std/http/file-server')
				return serveFile(c.req.raw, indexPath)
			}
		}

		return c.text('Not Found', 404)
	})
}

// ─── MIME types ───────────────────────────────────────────────────────────────

const staticMimeTypes: Record<string, string> = {
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