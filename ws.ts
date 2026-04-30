import type { Hono } from 'hono'
import type {
	WsOptions,
	WsConnection,
	ChannelApi,
	EventBus,
} from './types.ts'
import { Log } from './logger.ts'

// ─── Connection manager ──────────────────────────────────────────────────────

class ConnectionManager<T = Record<string, unknown>> {
	private connections = new Map<string, WsConnection<T>>()
	private channels = new Map<string, Set<string>>()

	add(conn: WsConnection<T>): void {
		this.connections.set(conn.id, conn)
	}

	remove(id: string): void {
		const conn = this.connections.get(id)
		if (!conn) return

		// Remove from all channels
		for (const channel of conn.channels) {
			const members = this.channels.get(channel)
			if (members) {
				members.delete(id)
				if (members.size === 0) this.channels.delete(channel)
			}
		}

		this.connections.delete(id)
	}

	get(id: string): WsConnection<T> | undefined {
		return this.connections.get(id)
	}

	join(connId: string, channel: string): void {
		const conn = this.connections.get(connId)
		if (!conn) return

		conn.channels.add(channel)

		let members = this.channels.get(channel)
		if (!members) {
			members = new Set()
			this.channels.set(channel, members)
		}
		members.add(connId)
	}

	leave(connId: string, channel: string): void {
		const conn = this.connections.get(connId)
		if (!conn) return

		conn.channels.delete(channel)

		const members = this.channels.get(channel)
		if (members) {
			members.delete(connId)
			if (members.size === 0) this.channels.delete(channel)
		}
	}

	broadcast(channel: string, data: unknown, exclude?: string): void {
		const members = this.channels.get(channel)
		if (!members) return

		const msg = typeof data === 'string' ? data : JSON.stringify(data)
		const dead: string[] = []

		for (const connId of members) {
			if (exclude && connId === exclude) continue
			const conn = this.connections.get(connId)
			if (!conn) {
				dead.push(connId)
				continue
			}
			try {
				conn.send(msg)
			} catch {
				dead.push(connId)
			}
		}

		for (const id of dead) {
			this.remove(id)
		}
	}

	members(channel: string): string[] {
		const set = this.channels.get(channel)
		return set ? [...set] : []
	}
}

// ─── Channel API factory ──────────────────────────────────────────────────────

function createChannelApi<T>(
	manager: ConnectionManager<T>,
	connId: string,
): ChannelApi {
	return {
		join(channel: string) {
			manager.join(connId, channel)
		},
		leave(channel: string) {
			manager.leave(connId, channel)
		},
		broadcast(channel: string, data: unknown, exclude?: string) {
			manager.broadcast(channel, data, exclude)
		},
		members(channel: string): string[] {
			return manager.members(channel)
		},
	}
}

// ─── Wire event bus to connection manager ─────────────────────────────────────

function wireEventBus<T>(
	manager: ConnectionManager<T>,
	events: EventBus,
): () => void {
	const unsubs: Array<() => void> = []

	// The event bus emits to channels — we forward to WebSocket connections
	// We intercept the emit by subscribing a listener that broadcasts
	const originalEmit = events.emit

	events.emit = (channel: string, data: unknown) => {
		// Call original emit (for SSE streams and other listeners)
		originalEmit(channel, data)
		// Forward to WebSocket connections in this channel
		manager.broadcast(channel, data)
	}

	return () => {
		events.emit = originalEmit
		for (const unsub of unsubs) unsub()
	}
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat(
	socket: WebSocket,
	interval: number,
): { stop: () => void; markAlive: () => void } {
	let alive = true

	const pingTimer = setInterval(() => {
		if (!alive) {
			socket.close(1001, 'ping timeout')
			return
		}
		alive = false
		try {
			socket.send(JSON.stringify({ type: '__ping' }))
		} catch {
			socket.close(1001, 'ping failed')
		}
	}, interval)

	return {
		stop: () => clearInterval(pingTimer),
		markAlive: () => { alive = true },
	}
}
// ─── mountWebSocket ───────────────────────────────────────────────────────────

export function mountWebSocket<T = Record<string, unknown>>(
	app: Hono,
	opts: WsOptions<T>,
): void {
	const path = opts.path ?? '/ws'
	const manager = new ConnectionManager<T>()
	const pingInterval = opts.ping?.interval ?? 30_000

	// Wire event bus if provided
	let _cleanupEvents: (() => void) | undefined
	if (opts.events) {
		_cleanupEvents = wireEventBus(manager, opts.events)
	}

	app.get(path, async (c) => {
		// ── Auth check before upgrade ─────────────────────────────────────
		let session: T | undefined

		if (opts.authenticate) {
			const result = await opts.authenticate(c)
			if (result === false) {
				return c.json({ message: 'Unauthorized', code: 401 }, 401)
			}
			session = result
		}

		// ── Upgrade ──────────────────────────────────────────────────────
		// deno-lint-ignore no-explicit-any
		const g = globalThis as any

		if (typeof g.Deno !== 'undefined') {
			const { response, socket } = g.Deno.upgradeWebSocket(c.req.raw)

			const connId = crypto.randomUUID()
			let heartbeat: { stop: () => void; markAlive: () => void } | undefined

			socket.onopen = () => {
				const conn: WsConnection<T> = {
					id: connId,
					session,
					metadata: {},
					channels: new Set(),
					send: (data: unknown) => {
						const msg = typeof data === 'string' ? data : JSON.stringify(data)
						socket.send(msg)
					},
					close: (code?: number, reason?: string) => {
						socket.close(code, reason)
					},
				}

				manager.add(conn)
				
				heartbeat = startHeartbeat(socket, pingInterval)

				const channels = createChannelApi(manager, connId)

				if (opts.onConnect) {
					try {
						opts.onConnect(conn, channels)
					} catch (err) {
						Log.error(`[ws] onConnect error: ${err}`)
					}
				}

				Log.debug(`[ws] connected: ${connId}`)
			}

			socket.onmessage = (e: MessageEvent) => {
				const conn = manager.get(connId)
				if (!conn) return

				let data: unknown

				try {
					data = JSON.parse(e.data as string)
				} catch {
					data = e.data
				}

				// Handle pong
				if (typeof data === 'object' && data !== null && (data as Record<string, unknown>).type === '__pong') {
					if (heartbeat) heartbeat.markAlive()
					return
				}
				if (opts.onMessage) {
					const channels = createChannelApi(manager, connId)
					try {
						opts.onMessage(conn, data, channels)
					} catch (err) {
						Log.error(`[ws] onMessage error: ${err}`)
					}
				}
			}

			socket.onclose = () => {
				const conn = manager.get(connId)
				if (heartbeat) heartbeat.stop()

				if (conn && opts.onClose) {
					try {
						opts.onClose(conn)
					} catch (err) {
						Log.error(`[ws] onClose error: ${err}`)
					}
				}

				manager.remove(connId)
				Log.debug(`[ws] disconnected: ${connId}`)
			}

			socket.onerror = (err: Event) => {
				const conn = manager.get(connId)
				if (conn && opts.onError) {
					try {
						opts.onError(conn, err)
					} catch (e) {
						Log.error(`[ws] onError handler error: ${e}`)
					}
				}
			}

			return response
		}

		// Non-Deno runtimes would use hono/ws upgradeWebSocket helper
		// For now, return unsupported
		return c.json({ message: 'WebSocket not supported on this runtime', code: 501 }, 501)
	})
}