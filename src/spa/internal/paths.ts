/**
 * @module
 * Path resolution helpers for SPA serving.
 */

/** Resolve a browser request pathname to a filesystem path relative to root. */
export function resolveRequestPath(pathname: string, root: string): string {
	const fsRoot = root.replace(/\/+$/, '')
	if (pathname.startsWith('/jsr/') || pathname.startsWith('/npm/')) {
		return pathname
	}
	return `${fsRoot}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
}

/** Stable 32-bit FNV-1a hash for ETag generation. */
export function hashCode(input: string): string {
	let h = 2166136261
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return (h >>> 0).toString(16)
}

/** True if pathname looks like a route the SPA should handle (no file extension). */
export function isSpaRoute(pathname: string): boolean {
	return !pathname.includes('.')
}

/** True if pathname should be transpiled (.ts/.tsx/.jsx or versioned dep). */
export function shouldTranspile(pathname: string): boolean {
	return (
		pathname.endsWith('.ts') ||
		pathname.endsWith('.tsx') ||
		pathname.endsWith('.jsx') ||
		pathname.startsWith('/jsr/') ||
		pathname.startsWith('/npm/')
	)
}