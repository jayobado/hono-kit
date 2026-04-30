/**
 * @module
 * Node.js runtime adapter. Uses @hono/node-server for HTTP, node:fs for
 * file I/O, and esbuild for TypeScript transpilation.
 */

import process from 'node:process'
import type { Hono } from 'hono'
import type { RuntimeAdapter, Transpiler } from '../types.ts'
import { Log } from '../logger.ts'

export const nodeAdapter: RuntimeAdapter = {
	name: 'node',

	serve(app: Hono, opts: { host: string; port: number }) {
		import('@hono/node-server').then(({ serve }) => {
			const server = serve({
				fetch: app.fetch,
				port: opts.port,
				hostname: opts.host,
			})

			console.log(`\n  ⬡  http://${opts.host}:${opts.port}\n`)

			function shutdown() {
				Log.info('Shutting down...')
				server.close(async () => {
					await Log.flush()
					process.exit(0)
				})
			}

			process.on('SIGINT', shutdown)
			process.on('SIGTERM', shutdown)
		})
	},

	async readFile(path: string): Promise<string> {
		const { readFile } = await import('node:fs/promises')
		return readFile(path, 'utf-8')
	},

	async readBinary(path: string): Promise<Uint8Array> {
		const { readFile } = await import('node:fs/promises')
		const buffer = await readFile(path)
		return new Uint8Array(buffer)
	},

	async *readDir(path: string) {
		const { readdir } = await import('node:fs/promises')
		const entries = await readdir(path, { withFileTypes: true })
		for (const entry of entries) {
			yield {
				name: entry.name,
				isFile: entry.isFile(),
				isDirectory: entry.isDirectory(),
			}
		}
	},

	async writeFile(path: string, content: string): Promise<void> {
		const { writeFile } = await import('node:fs/promises')
		await writeFile(path, content, 'utf-8')
	},

	async mkdir(path: string): Promise<void> {
		const { mkdir } = await import('node:fs/promises')
		await mkdir(path, { recursive: true })
	},

	createTranspiler(): Transpiler {
		return createEsbuildTranspiler()
	},
}

// ─── esbuild transpiler ──────────────────────────────────────────────────────

function createEsbuildTranspiler(): Transpiler {
	const cache = new Map<string, string>()

	async function transpile(path: string, opts: { importMap?: string | { imports: Record<string, string> }; compilerOptions?: Record<string, unknown> }): Promise<string | null> {
		if (cache.has(path)) return cache.get(path)!

		try {
			const esbuild = await import('esbuild')
			const { readFile } = await import('node:fs/promises')

			const content = path.startsWith('http')
				? await (await fetch(path)).text()
				: await readFile(path, 'utf-8')

			const result = await esbuild.transform(content, {
				loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
				format: 'esm',
				target: 'esnext',
				jsx: opts.compilerOptions?.jsx as 'transform' | 'preserve' | 'automatic' | undefined,
				jsxImportSource: opts.compilerOptions?.jsxImportSource as string | undefined,
			})

			cache.set(path, result.code)
			return result.code
		} catch (err) {
			console.error(`[transpile] ${path} — ${err}`)
			return null
		}
	}

	async function warm(root: string, opts: { importMap?: string | { imports: Record<string, string> }; compilerOptions?: Record<string, unknown> }): Promise<number> {
		const { readdir } = await import('node:fs/promises')
		const { join } = await import('node:path')
		let count = 0

		async function walk(dir: string): Promise<void> {
			const entries = await readdir(dir, { withFileTypes: true })
			for (const entry of entries) {
				const full = join(dir, entry.name)
				if (entry.isDirectory()) {
					await walk(full)
					continue
				}
				if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
					const code = await transpile(full, opts)
					if (code) count++
				}
			}
		}

		await walk(root)
		return count
	}

	return { transpile, warm }
}