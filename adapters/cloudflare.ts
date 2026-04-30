import type { Hono } from 'hono'
import type { RuntimeAdapter } from '../types.ts'

export const cloudflareAdapter: RuntimeAdapter = {
	name: 'cloudflare',

	serve(_app: Hono, _opts: { host: string; port: number }) {
		// Workers runtime calls app.fetch directly — no server.listen
		// Use createApp() instead of createServer() for Workers
		console.warn(
			'[hono-kit] Cloudflare Workers does not use serve(). ' +
			'Use createApp() and export default the result.',
		)
	},

	// Workers cannot read from the filesystem at runtime
	// Static assets are served by Cloudflare Pages or Workers Sites

	// No transpiler — Workers must use pre-built bundles
	// Run `build()` at deploy time
}