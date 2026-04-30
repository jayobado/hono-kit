import { Log } from './logger.ts'
import type { BuildOptions } from './types.ts'

// ─── Content hash ─────────────────────────────────────────────────────────────

async function contentHash(content: string): Promise<string> {
	const data = new TextEncoder().encode(content)
	const digest = await crypto.subtle.digest('SHA-256', data)
	const hex = Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('')
	return hex.slice(0, 8)
}

// ─── Loader ───────────────────────────────────────────────────────────────────

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

// ─── build ────────────────────────────────────────────────────────────────────

export async function build(opts: BuildOptions): Promise<void> {
	const {
		entry,
		outDir = './dist',
		importMap,
		minify = false,
		compilerOptions,
	} = opts

	const { bundle } = await import('@deno/emit')

	Log.info(`Building: ${entry}`)
	const start = performance.now()

	// ── Bundle ────────────────────────────────────────────────────────────

	const result = await bundle(entry, {
		importMap,
		compilerOptions,
		load: createLoader(),
	})

	let code = result.code

	// ── Minify (basic — remove comments and collapse whitespace) ──────────

	if (minify) {
		code = code
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\n\s*\n/g, '\n')
			.replace(/^\s+/gm, '')
	}

	// ── Hash and write ────────────────────────────────────────────────────

	const hash = await contentHash(code)
	const entryName = entry.split('/').pop()!.replace(/\.[^.]+$/, '')
	const outFile = `${outDir}/${entryName}.${hash}.js`

	await Deno.mkdir(outDir, { recursive: true })
	await Deno.writeTextFile(outFile, code)

	// ── Find and copy static files ────────────────────────────────────────

	const entryDir = entry.substring(0, entry.lastIndexOf('/'))

	async function copyDir(src: string, dest: string): Promise<void> {
		await Deno.mkdir(dest, { recursive: true })

		for await (const entry of Deno.readDir(src)) {
			const srcPath = `${src}/${entry.name}`
			const destPath = `${dest}/${entry.name}`

			if (entry.isDirectory) {
				await copyDir(srcPath, destPath)
				continue
			}

			if (entry.isFile) {
				// Skip TypeScript files — they're bundled
				if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) continue

				if (entry.name === 'index.html') {
					// Rewrite script tag to reference the hashed bundle
					let html = await Deno.readTextFile(srcPath)
					html = html.replace(
						/<script\s+type="module"\s+src="[^"]*"[^>]*><\/script>/,
						`<script type="module" src="/${entryName}.${hash}.js"></script>`,
					)
					await Deno.writeTextFile(destPath, html)
					continue
				}

				await Deno.copyFile(srcPath, destPath)
			}
		}
	}

	await copyDir(entryDir, outDir)

	// ── Summary ───────────────────────────────────────────────────────────

	const elapsed = ((performance.now() - start) / 1000).toFixed(2)
	const kb = (new TextEncoder().encode(code).length / 1024).toFixed(1)

	Log.info(`Build complete in ${elapsed}s`)
	Log.info(`  ${outFile} (${kb} KB)`)
}