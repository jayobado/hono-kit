/**
 * @module
 * WebSocket primitives: a connection-state manager (createChannels) and a
 * handler factory (createWsHandler). They're independent — you can use the
 * handler without channels, or manage channels without a handler.
 *
 * Deno-only (uses Deno.upgradeWebSocket).
 *
 *   const channels = createChannels()
 *   const ws = createWsHandler({
 *     authenticate: (c) => auth.getSession(c) ?? false,
 *     onConnect: (conn) => channels.add(conn),
 *     onClose: (conn) => channels.remove(conn),
 *     onMessage: (conn, data) => channels.broadcast('chat', data),
 *   })
 *   app.get('/ws', ws)
 *
 *   // Bus → WS fanout (explicit, no monkey-patching)
 *   events.on('orders', (msg) => channels.broadcast('orders', msg))
 */

import type { Context } from 'hono'
import { Log } from './logger.ts'

// ─── Connection ──────────────────────────────────────────────────────────────

export interface WsConnection<T = unknown> {
	readonly id: string
	readonly session?: T
	readonly metadata: Record<string, unknown>
	readonly channels: Set<string>
	send(data: unknown): void
	close(code?: number, reason?: string): void
}

function createConnection<T>(socket: WebSocket, session?: T): WsConnection<T> {
	return {
		id: crypto.randomUUID(),
		session,
		metadata: {},
		channels: new Set(),
		send(data) {
			if (socket.readyState !== WebSocket.OPEN) return
			try {
				socket.send(typeof data === 'string' ? data : JSON.stringify(data))
			} catch (err) {
				Log.error(`[ws] send failed: ${err instanceof Error ? err.message : String(err)}`)
			}
		},
		close(code, reason) {
			try { socket.close(code, reason) } catch { /* already closed */ }
		},
	}
}

// ─── Channels ────────────────────────────────────────────────────────────────

export interface Channels<T = unknown> {
	add(conn: WsConnection<T>): void
	remove(conn: WsConnection<T>): void
	join(conn: WsConnection<T>, channel: string): void
	leave(conn: WsConnection<T>, channel: string): void
	broadcast(channel: string, data: unknown, excludeId?: string): void
	members(channel: string): WsConnection<T>[]
	all(): WsConnection<T>[]
	size(): number
}

export function createChannels<T = unknown>(): Channels<T> {
	const connections = new Map<string, WsConnection<T>>()
	const channels = new Map<string, Set<string>>()

	function getChannel(name: string): Set<string> {
		let set = channels.get(name)
		if (!set) {
			set = new Set()
			channels.set(name, set)
		}
		return set
	}

	return {
		add(conn) {
			connections.set(conn.id, conn)
		},

		remove(conn) {
			connections.delete(conn.id)
			for (const ch of conn.channels) {
				channels.get(ch)?.delete(conn.id)
			}
		},

		join(conn, channel) {
			getChannel(channel).add(conn.id)
			conn.channels.add(channel)
		},

		leave(conn, channel) {
			channels.get(channel)?.delete(conn.id)
			conn.channels.delete(channel)
		},

		broadcast(channel, data, excludeId) {
			const memberIds = channels.get(channel)
			if (!memberIds) return
			for (const id of memberIds) {
				if (id === excludeId) continue
				connections.get(id)?.send(data)
			}
		},

		members(channel) {
			const ids = channels.get(channel)
			if (!ids) return []
			const result: WsConnection<T>[] = []
			for (const id of ids) {
				const conn = connections.get(id)
				if (conn) result.push(conn)
			}
			return result
		},

		all() {
			return [...connections.values()]
		},

		size() {
			return connections.size
		},
	}
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export interface WsHandlerOptions<T = unknown> {
	authenticate?: (c: Context) => Promise<T | false> | T | false
	onConnect?: (conn: WsConnection<T>) => void | Promise<void>
	onMessage?: (conn: WsConnection<T>, data: unknown) => void | Promise<void>
	onClose?: (conn: WsConnection<T>) => void | Promise<void>
	onError?: (conn: WsConnection<T>, err: unknown) => void
	pingInterval?: number
}

export type WsHandler = (c: Context) => Response | Promise<Response>

export function createWsHandler<T = unknown>(opts: WsHandlerOptions<T> = {}): WsHandler {
	return async (c: Context): Promise<Response> => {
		let session: T | undefined
		if (opts.authenticate) {
			const result = await opts.authenticate(c)
			if (result === false) {
				return c.json({ message: 'Unauthorized', code: 401 }, 401)
			}
			session = result as T
		}

		// deno-lint-ignore no-explicit-any
		const d = (globalThis as any).Deno
		if (!d?.upgradeWebSocket) {
			return c.json({ message: 'WebSocket not supported on this runtime', code: 501 }, 501)
		}

		const { response, socket } = d.upgradeWebSocket(c.req.raw) as {
			response: Response
			socket: WebSocket
		}

		const conn = createConnection<T>(socket, session)
		let pingTimer: ReturnType<typeof setInterval> | undefined

		socket.onopen = () => {
			Log.debug(`[ws] connect ${conn.id}`)
			if (opts.pingInterval && opts.pingInterval > 0) {
				pingTimer = setInterval(() => {
					if (socket.readyState === WebSocket.OPEN) {
						try { socket.send('ping') } catch { /* will be caught by error handler */ }
					}
				}, opts.pingInterval)
			}
			try { opts.onConnect?.(conn) } catch (err) { opts.onError?.(conn, err) }
		}

		socket.onmessage = (e: MessageEvent) => {
			let data: unknown = e.data
			if (typeof data === 'string') {
				try { data = JSON.parse(data) } catch { /* keep raw string */ }
			}
			try { opts.onMessage?.(conn, data) } catch (err) { opts.onError?.(conn, err) }
		}

		socket.onclose = () => {
			Log.debug(`[ws] close ${conn.id}`)
			if (pingTimer) clearInterval(pingTimer)
			try { opts.onClose?.(conn) } catch (err) { opts.onError?.(conn, err) }
		}

		socket.onerror = (e: Event) => {
			opts.onError?.(conn, e)
		}

		return response
	}
}