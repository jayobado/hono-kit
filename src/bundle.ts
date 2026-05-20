/**
 * @module
 * Production build tool. Bundles a TypeScript SPA entry into hashed static
 * files and writes a manifest.json that serveAssets() consumes.
 *
 * The build does:
 *   1. Bundles the JS entry via @deno/emit, content-hashes it, writes the file.
 *   2. Walks the source directory, copies non-TS files through. CSS files get
 *      content-hashed; other static assets pass through with their original names.
 *   3. Copies index.html verbatim — placeholders like __ASSET("main.js")__
 *      remain intact and are resolved at serve time by serveAssets.
 *   4. Writes manifest.json mapping logical entry names → hashed filenames.
 *
 *   await build({
 *     entry: './client/main.tsx',
 *     outDir: './dist',
 *     importMap: './deno.json',
 *   })
 *
 *   // → dist/main.abc12345.js
 *   //   dist/index.html (verbatim, with placeholders)
 *   //   dist/manifest.json   { "main.js": "main.abc12345.js", ... }
 */

import { Log } from './logger.ts'

export interface BuildOptions {
	entry: string
	outDir?: string
	importMap?: string | { imports: Record<string, string> }
	minify?: boolean
	compilerOptions?: Record<string, unknown>
	staticRoot?: string
}

export interface BuildResult {
	outDir: string
	manifest: Record<string, string>
	bundleSize: number
	elapsedMs: number
}

async function contentHash(content: string | Uint8Array): Promise<string> {
	const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
	const hex = Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('')
	return hex.slice(0, 8)
}

function createLoader() {
	return async (specifier: string) => {
		if (!specifier.startsWith('http')) {
			try {
				const path = specifier.startsWith('file://')
					? new URL(specifier).pathname
					: specifier
				const content = await Deno.readTextFile(path)
				return { kind: 'module' as const, specifier, content }
			} catch {
				return undefined
			}
		}

		try {
			const res = await fetch(specifier)
			if (!res.ok) return undefined
			const content = await res.text()
			return { kind: 'module' as const, specifier, content }
		} catch {
			return undefined
		}
	}
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
	const entry = opts.entry
	const outDir = (opts.outDir ?? './dist').replace(/\/+$/, '')
	const staticRoot = (opts.staticRoot ?? entry.substring(0, entry.lastIndexOf('/'))).replace(/\/+$/, '')

	Log.info(`[build] entry: ${entry}`)
	const start = performance.now()

	const { bundle } = await import('@deno/emit')

	const result = await bundle(entry, {
		importMap: opts.importMap,
		compilerOptions: opts.compilerOptions,
		load: createLoader(),
	})

	let code = result.code
	if (opts.minify) {
		code = code
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\n\s*\n/g, '\n')
			.replace(/^\s+/gm, '')
	}

	const entryBaseName = entry.split('/').pop()!.replace(/\.[^.]+$/, '')
	const jsHash = await contentHash(code)
	const jsHashedName = `${entryBaseName}.${jsHash}.js`
	const jsLogicalName = `${entryBaseName}.js`

	const manifest: Record<string, string> = {
		[jsLogicalName]: jsHashedName,
	}

	await Deno.mkdir(outDir, { recursive: true })
	await Deno.writeTextFile(`${outDir}/${jsHashedName}`, code)

	async function processDir(srcDir: string, destDir: string, relPrefix = ''): Promise<void> {
		await Deno.mkdir(destDir, { recursive: true })

		for await (const item of Deno.readDir(srcDir)) {
			const srcPath = `${srcDir}/${item.name}`
			const relPath = `${relPrefix}${item.name}`

			if (item.isDirectory) {
				await processDir(srcPath, `${destDir}/${item.name}`, `${relPath}/`)
				continue
			}

			if (!item.isFile) continue

			if (/\.(ts|tsx|jsx)$/.test(item.name)) continue

			if (item.name.endsWith('.css')) {
				const content = await Deno.readFile(srcPath)
				const hash = await contentHash(content)
				const base = item.name.replace(/\.css$/, '')
				const hashed = `${base}.${hash}.css`
				const destPath = `${destDir}/${hashed}`
				await Deno.writeFile(destPath, content)
				manifest[relPath] = `${relPrefix}${hashed}`
				continue
			}

			const content = await Deno.readFile(srcPath)
			await Deno.writeFile(`${destDir}/${item.name}`, content)
		}
	}

	await processDir(staticRoot, outDir)

	await Deno.writeTextFile(
		`${outDir}/manifest.json`,
		JSON.stringify(manifest, null, 2),
	)

	const elapsedMs = Math.round(performance.now() - start)
	const bundleSize = new TextEncoder().encode(code).length

	Log.info(`[build] complete in ${elapsedMs}ms`)
	Log.info(`[build]   ${jsHashedName} (${(bundleSize / 1024).toFixed(1)} KB)`)
	for (const [logical, hashed] of Object.entries(manifest)) {
		if (logical === jsLogicalName) continue
		Log.info(`[build]   ${hashed} ← ${logical}`)
	}

	return { outDir, manifest, bundleSize, elapsedMs }
}