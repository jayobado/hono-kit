/**
 * @module
 * MIME type lookup by file extension. Used by all SPA modes.
 */

export const MIME_TYPES: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	eot: 'application/vnd.ms-fontobject',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	pdf: 'application/pdf',
	txt: 'text/plain; charset=utf-8',
	xml: 'application/xml',
	wasm: 'application/wasm',
	map: 'application/json',
}

export function mimeFor(pathname: string): string | undefined {
	const ext = pathname.split('.').pop()?.toLowerCase()
	return ext ? MIME_TYPES[ext] : undefined
}

const TEXT_HINTS = ['text/', 'javascript', 'json', 'xml', 'svg']

export function isTextMime(mime: string): boolean {
	return TEXT_HINTS.some(h => mime.includes(h))
}

const COMPRESSIBLE_HINTS = ['text/', 'javascript', 'json', 'svg+xml']

export function isCompressible(mime: string): boolean {
	return COMPRESSIBLE_HINTS.some(h => mime.includes(h))
}