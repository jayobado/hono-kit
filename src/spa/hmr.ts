/**
 * @module
 * Hot module reload helpers for dev mode. createHmr returns a Hono handler
 * and a broadcast function — wire your file watcher to call broadcast() on
 * changes, and the connected clients reload (or hot-swap CSS).
 *
 * Deno-only. Uses Deno.upgradeWebSocket and Deno.watchFs.
 */

import type { Context } from 'hono'
import { Log } from '../logger.ts'

const HMR_CLIENT_SCRIPT = `
<script>
(function() {
	const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '__HMR_PATH__');
	ws.onmessage = function(e) {
		const msg = JSON.parse(e.data);
		if (msg.type === 'reload') location.reload();
		if (msg.type === 'css') {
			document.querySelectorAll('link[rel=stylesheet]').forEach(function(l) {
				l.href = l.href.replace(/\\?.*$/, '') + '?t=' + Date.now();
			});
		}
	};
	ws.onclose = function() { setTimeout(function() { location.reload(); }, 1000); };
})();
</script>
`.trim()

export function injectHmrClient(html: string, path: string): string {
	const script = HMR_CLIENT_SCRIPT.replace('__HMR_PATH__', path)
	if (html.includes('</body>')) {
		return html.replace('</body>', `${script}</body>`)
	}
	return html + script
}

export type HmrMessage =
	| { type: 'reload'; path?: string }
	| { type: 'css'; path?: string }

export interface Hmr {
	handler(c: Context): Response
	broadcast(msg: HmrMessage): void
	clientCount(): number
	dispose(): void
}

export function createHmr(opts: { path?: string } = {}): Hmr {
	const _path = opts.path ?? '/__hmr'
	const clients = new Set<WebSocket>()

	return {
		handler(c) {
			const { response, socket } = Deno.upgradeWebSocket(c.req.raw)
			socket.onopen = () => {
				clients.add(socket)
				Log.debug(`[hmr] client connected (${clients.size})`)
			}
			socket.onclose = () => {
				clients.delete(socket)
				Log.debug(`[hmr] client disconnected (${clients.size})`)
			}
			socket.onerror = () => clients.delete(socket)
			return response
		},

		broadcast(msg) {
			const payload = JSON.stringify(msg)
			for (const ws of clients) {
				if (ws.readyState === WebSocket.OPEN) {
					try { ws.send(payload) } catch { clients.delete(ws) }
				}
			}
		},

		clientCount() {
			return clients.size
		},

		dispose() {
			for (const ws of clients) {
				try { ws.close() } catch { /* ignore */ }
			}
			clients.clear()
		},
	}
}

export interface WatchEvent {
	kind: 'modify' | 'create' | 'remove'
	paths: string[]
}

export function watchFs(
	root: string,
	onChange: (event: WatchEvent) => void,
): () => void {
	const watcher = Deno.watchFs(root)
	let cancelled = false

		; (async () => {
			Log.debug(`[hmr] watching ${root}`)
			try {
				for await (const event of watcher) {
					if (cancelled) break
					if (event.kind === 'modify' || event.kind === 'create' || event.kind === 'remove') {
						onChange({ kind: event.kind as WatchEvent['kind'], paths: event.paths })
					}
				}
			} catch (err) {
				if (!cancelled) {
					Log.error(`[hmr] watcher error: ${err instanceof Error ? err.message : String(err)}`)
				}
			}
		})()

	return () => {
		cancelled = true
		try { watcher.close() } catch { /* already closed */ }
	}
}