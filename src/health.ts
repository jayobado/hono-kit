/**
 * @module
 * Health, readiness, and version endpoints. Used by both createApiApp and
 * createBff but also usable directly: mountHealth(app, { ... }).
 *
 *   mountHealth(app, {
 *     version: '1.2.3',
 *     checks: {
 *       db: () => db.ping(),
 *       cache: () => redis.ping(),
 *     },
 *   })
 */

import type { Hono } from 'hono'

export interface HealthOptions {
	/** Liveness endpoint path. Default '/health'. */
	path?: string
	/** Readiness endpoint path. Default '/ready'. */
	readyPath?: string
	/** Version string returned by /health and /version. */
	version?: string
	/** Async checks run by /ready. Each returns true if healthy. */
	checks?: Record<string, () => Promise<boolean>>
}

export function mountHealth(app: Hono, opts: HealthOptions = {}): void {
	const healthPath = opts.path ?? '/health'
	const readyPath = opts.readyPath ?? '/ready'
	const version = opts.version
	const checks = opts.checks ?? {}

	app.get(healthPath, (c) => c.json({
		status: 'ok',
		...(version ? { version } : {}),
	}))

	app.get(readyPath, async (c) => {
		const results: Record<string, boolean> = {}
		let allOk = true

		await Promise.all(
			Object.entries(checks).map(async ([name, check]) => {
				try {
					const ok = await check()
					results[name] = ok
					if (!ok) allOk = false
				} catch {
					results[name] = false
					allOk = false
				}
			}),
		)

		return c.json(
			{ status: allOk ? 'ready' : 'not_ready', checks: results },
			allOk ? 200 : 503,
		)
	})

	if (version) {
		app.get('/version', (c) => c.json({ version }))
	}
}