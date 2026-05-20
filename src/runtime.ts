/**
 * @module
 * Runtime-specific helpers for serving Hono apps. Each function takes a Hono
 * app and runtime options, and returns a handle with a shutdown() method.
 *
 * Includes a shared shutdown registry: any module that needs cleanup on
 * SIGINT/SIGTERM can call onShutdown(fn) to register a handler. The runtime
 * helpers drain all registered handlers before exiting.
 *
 *   const dev = createDevServer({ root: './client' })
 *   onShutdown(() => dev.dispose())
 *
 *   const server = await serveDeno(app, { port: 3000 })
 *   // Ctrl-C → drains registered handlers, closes the server, exits.
 *
 * For Cloudflare Workers, no helper is needed:
 *   export default { fetch: app.fetch }
 */

import type { Hono } from 'hono'
import { Log } from './logger.ts'

// ─── Shutdown registry ───────────────────────────────────────────────────────

const shutdownHandlers: Array<() => void | Promise<void>> = []
let signalsWired = false

/** Register a function to run during graceful shutdown. */
export function onShutdown(fn: () => void | Promise<void>): void {
	shutdownHandlers.push(fn)
}

/** Run all registered shutdown handlers in reverse registration order. */
export async function runShutdown(): Promise<void> {
	for (const fn of [...shutdownHandlers].reverse()) {
		try {
			await fn()
		} catch (err) {
			Log.error(`[shutdown] handler failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	shutdownHandlers.length = 0
}

function wireDenoSignals(onSignal: () => void): void {
	if (signalsWired) return
	signalsWired = true
	// deno-lint-ignore no-explicit-any
	const d = (globalThis as any).Deno
	if (!d?.addSignalListener) return
	try {
		d.addSignalListener('SIGINT', onSignal)
		d.addSignalListener('SIGTERM', onSignal)
	} catch {
		// Some platforms (Windows) don't support all signals. Silently skip.
	}
}

function wireNodeSignals(onSignal: () => void): void {
	if (signalsWired) return
	signalsWired = true
	// deno-lint-ignore no-explicit-any
	const p = (globalThis as any).process
	if (!p?.on) return
	p.on('SIGINT', onSignal)
	p.on('SIGTERM', onSignal)
}

// ─── Server handle ───────────────────────────────────────────────────────────

export interface ServerHandle {
	port: number
	hostname: string
	shutdown(): Promise<void>
	finished: Promise<void>
}

export interface ServeOptions {
	port?: number
	hostname?: string
	onListen?: (info: { port: number; hostname: string }) => void
}

// ─── Deno ────────────────────────────────────────────────────────────────────

export function serveDeno(app: Hono, opts: ServeOptions = {}): ServerHandle {
	// deno-lint-ignore no-explicit-any
	const d = (globalThis as any).Deno
	if (!d?.serve) {
		throw new Error('serveDeno: Deno.serve not available; are you running under Deno?')
	}

	const port = opts.port ?? 8000
	const hostname = opts.hostname ?? '0.0.0.0'

	const server = d.serve({
		port,
		hostname,
		onListen: (info: { port: number; hostname: string }) => {
			Log.info(`[serve] listening on http://${info.hostname}:${info.port}`)
			opts.onListen?.(info)
		},
	}, app.fetch)

	let shuttingDown = false
	const shutdown = async () => {
		if (shuttingDown) return
		shuttingDown = true
		Log.info('[serve] shutting down…')
		await runShutdown()
		try { await server.shutdown() } catch { /* already closed */ }
		Log.info('[serve] stopped')
	}

	wireDenoSignals(() => { void shutdown() })

	return {
		port,
		hostname,
		shutdown,
		finished: server.finished as Promise<void>,
	}
}

// ─── Node ────────────────────────────────────────────────────────────────────

export async function serveNode(app: Hono, opts: ServeOptions = {}): Promise<ServerHandle> {
	const { serve } = await import('@hono/node-server')

	const port = opts.port ?? 3000
	const hostname = opts.hostname ?? '0.0.0.0'

	let finishedResolve: () => void = () => { }
	const finished = new Promise<void>(r => { finishedResolve = r })

	const server = serve({
		fetch: app.fetch,
		port,
		hostname,
	}, (info: { address: string; port: number }) => {
		Log.info(`[serve] listening on http://${info.address}:${info.port}`)
		opts.onListen?.({ port: info.port, hostname: info.address })
	})

	let shuttingDown = false
	const shutdown = async () => {
		if (shuttingDown) return
		shuttingDown = true
		Log.info('[serve] shutting down…')
		await runShutdown()
		await new Promise<void>((resolve) => {
			// deno-lint-ignore no-explicit-any
			(server as any).close(() => resolve())
		})
		finishedResolve()
		Log.info('[serve] stopped')
	}

	wireNodeSignals(() => { void shutdown() })

	return { port, hostname, shutdown, finished }
}