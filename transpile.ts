import { Log } from './logger.ts'
import type { Transpiler, RuntimeAdapter } from './types.ts'

// ─── Shared cache ─────────────────────────────────────────────────────────────

const cache = new Map<string, string>()

// ─── Import map loading ──────────────────────────────────────────────────────

export async function loadImportMap(
	importMap: string | { imports: Record<string, string> } | undefined,
	adapter: RuntimeAdapter,
): Promise<Record<string, string>> {
	if (!importMap) return {}
	if (typeof importMap === 'object') return importMap.imports ?? {}
	try {
		const raw = adapter.readFile
			? await adapter.readFile(importMap)
			: await (await fetch(importMap)).text()
		const json = JSON.parse(raw)
		return json.imports ?? {}
	} catch {
		return {}
	}
}

// ─── Lock file version resolution ─────────────────────────────────────────────

export async function loadLockVersions(
	importMap: string | { imports: Record<string, string> } | undefined,
	adapter: RuntimeAdapter,
): Promise<Map<string, string>> {
	const versions = new Map<string, string>()
	if (!importMap || typeof importMap !== 'string') return versions

	const dir = importMap.replace(/\/[^/]+$/, '') || '.'
	const lockPath = `${dir}/deno.lock`

	try {
		if (!adapter.readFile) return versions
		const raw = await adapter.readFile(lockPath)
		const lock = JSON.parse(raw)
		const specifiers = lock.specifiers ?? {}
		for (const [spec, version] of Object.entries(specifiers)) {
			const match = spec.match(/^jsr:(@[^/]+\/[^@]+)@/)
			if (match) {
				versions.set(match[1], version as string)
			}
		}
	} catch { /* no lock file */ }

	return versions
}

// ─── Import rewriting ─────────────────────────────────────────────────────────

export async function buildRewriteMap(
	imports: Record<string, string>,
	importMap: string | { imports: Record<string, string> } | undefined,
	adapter: RuntimeAdapter,
): Promise<Map<string, string>> {
	const lockVersions = await loadLockVersions(importMap, adapter)
	const rewrites = new Map<string, string>()

	for (const [alias, target] of Object.entries(imports)) {
		const jsrMatch = target.match(/^jsr:(@[^/]+\/[^@/]+)(?:@[^/]*)?(?:\/(.*))?$/)
		if (jsrMatch) {
			const [, pkg, subpath] = jsrMatch
			const version = lockVersions.get(pkg)
			if (version) {
				rewrites.set(alias, `/jsr/${pkg}/${version}/${subpath ?? 'mod.ts'}`)
			}
			continue
		}

		const npmMatch = target.match(/^npm:(@?[^@/]+(?:\/[^@/]+)?)(?:@[^/]*)?(?:\/(.*))?$/)
		if (npmMatch) {
			const [, pkg, subpath] = npmMatch
			rewrites.set(alias, `/npm/${pkg}${subpath ? '/' + subpath : ''}`)
		}
	}

	return rewrites
}

export function rewriteImports(code: string, rewrites: Map<string, string>): string {
	const sorted = [...rewrites.entries()].sort((a, b) => b[0].length - a[0].length)

	for (const [alias, servePath] of sorted) {
		const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		code = code.replaceAll(
			new RegExp(`(from\\s*['"])${escaped}(['"])`, 'g'),
			`$1${servePath}$2`,
		)
		code = code.replaceAll(
			new RegExp(`(import\\s*\\(\\s*['"])${escaped}(['"]\\s*\\))`, 'g'),
			`$1${servePath}$2`,
		)
	}

	return code
}

// ─── Resolve request path to specifier ────────────────────────────────────────

export function resolveRequestPath(pathname: string, fsRoot: string): string {
	if (pathname.startsWith('/jsr/')) {
		return `https://jsr.io${pathname.slice(4)}`
	}
	if (pathname.startsWith('/npm/')) {
		return `https://esm.sh/${pathname.slice(5)}`
	}
	return `${fsRoot}${pathname}`
}

// ─── Path normalization ───────────────────────────────────────────────────────

export function toFileUrl(path: string): string {
	if (path.startsWith('file://')) return path
	if (path.startsWith('http')) return path
	// deno-lint-ignore no-explicit-any
	const g = globalThis as any
	const cwd = typeof g.Deno !== 'undefined'
		? g.Deno.cwd()
		: typeof g.process !== 'undefined'
			? g.process.cwd()
			: '.'
	const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
	return `file://${absolute}`
}

// ─── ETag hash ────────────────────────────────────────────────────────────────

export function hashCode(str: string): string {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash) + str.charCodeAt(i)
		hash |= 0
	}
	return Math.abs(hash).toString(36)
}

// ─── Deno transpiler ──────────────────────────────────────────────────────────

export function createDenoTranspiler(): Transpiler {
	let transpileFn: typeof import('@deno/emit').transpile | undefined

	async function getTranspile() {
		if (!transpileFn) {
			const mod = await import('@deno/emit')
			transpileFn = mod.transpile
		}
		return transpileFn
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

	return {
		async transpile(path, opts) {
			const specifier = path.startsWith('http') ? path : toFileUrl(path)

			if (cache.has(specifier)) return cache.get(specifier)!

			try {
				const fn = await getTranspile()
				const loader = createLoader()
				const result = await fn(specifier, {
					importMap: opts.importMap,
					compilerOptions: opts.compilerOptions,
					load: loader,
				})

				const code = result.get(specifier)
				if (!code) return null

				cache.set(specifier, code)
				return code
			} catch (err) {
				Log.error(
					`[transpile] ${specifier} — ${err instanceof Error ? err.message : String(err)}`,
				)
				return null
			}
		},

		async warm(root, opts) {
			const loader = createLoader()
			const fn = await getTranspile()
			let count = 0

			async function walk(dir: string): Promise<void> {
				for await (const entry of Deno.readDir(dir)) {
					const full = `${dir}/${entry.name}`
					if (entry.isDirectory) {
						await walk(full)
						continue
					}
					if (entry.isFile && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
						const specifier = toFileUrl(full)
						if (cache.has(specifier)) { count++; continue }

						try {
							const result = await fn(specifier, {
								importMap: opts.importMap,
								compilerOptions: opts.compilerOptions,
								load: loader,
							})
							const code = result.get(specifier)
							if (code) {
								cache.set(specifier, code)
								count++
								Log.debug(`Cached: ${full.replace(root, '')}`)
							}
						} catch (err) {
							Log.error(`[transpile] ${full} — ${err instanceof Error ? err.message : String(err)}`)
						}
					}
				}
			}

			await walk(root)
			return count
		},
	}
}

// ─── Cache invalidation ──────────────────────────────────────────────────────

export function invalidateCache(path: string): void {
	const key = toFileUrl(path)
	cache.delete(key)
	Log.debug(`[transpile] cache invalidated: ${key}`)
}

export { cache }