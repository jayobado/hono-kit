import type { Context } from 'hono'
import type { EventBus, BroadcastAdapter } from './types.ts'

// ─── createEventBus ───────────────────────────────────────────────────────────

export function createEventBus(adapter?: BroadcastAdapter): EventBus {
	const listeners = new Map<string, Set<(data: unknown) => void>>()
	const sseStreams = new Map<string, Set<ReadableStreamDefaultController>>()

	function on(channel: string, handler: (data: unknown) => void): () => void {
		let set = listeners.get(channel)
		if (!set) {
			set = new Set()
			listeners.set(channel, set)
		}
		set.add(handler)

		if (adapter) {
			adapter.subscribe(channel, handler)
		}

		return () => {
			set!.delete(handler)
			if (set!.size === 0) listeners.delete(channel)
			if (adapter) {
				adapter.unsubscribe(channel)
			}
		}
	}

	function emit(channel: string, data: unknown): void {
		// Local listeners
		const set = listeners.get(channel)
		if (set) {
			for (const handler of set) {
				try {
					handler(data)
				} catch { /* don't break the emit loop */ }
			}
		}

		// SSE streams
		const streams = sseStreams.get(channel)
		if (streams) {
			const msg = `data: ${JSON.stringify(data)}\n\n`
			const dead: ReadableStreamDefaultController[] = []
			for (const controller of streams) {
				try {
					controller.enqueue(new TextEncoder().encode(msg))
				} catch {
					dead.push(controller)
				}
			}
			for (const controller of dead) {
				streams.delete(controller)
			}
			if (streams.size === 0) sseStreams.delete(channel)
		}

		// Broadcast adapter
		if (adapter) {
			adapter.publish(channel, data).catch(() => { })
		}
	}

	function stream(_c: Context, channel: string): Response {
		let controller: ReadableStreamDefaultController

		const body = new ReadableStream({
			start(ctrl) {
				controller = ctrl
				let set = sseStreams.get(channel)
				if (!set) {
					set = new Set()
					sseStreams.set(channel, set)
				}
				set.add(controller)
			},
			cancel() {
				const set = sseStreams.get(channel)
				if (set) {
					set.delete(controller)
					if (set.size === 0) sseStreams.delete(channel)
				}
			},
		})

		return new Response(body, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			},
		})
	}

	return { emit, on, stream }
}