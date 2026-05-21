import {
	createAuth,
	createUpstream,
	createBff,
	defineRoute,
	defineRoutes,
	serveAssets,
	requestId,
	accessLog,
	errorHandler,
} from '@jayobado/hono-kit'
import { createKvSessionStore } from '@jayobado/hono-kit/cf-stores'
import { getAssetFromKV } from '@cloudflare/kv-asset-handler'

interface Env {
	SESSIONS: KVNamespace
	__STATIC_CONTENT: KVNamespace
	UPSTREAM_BASE_URL: string
	SESSION_COOKIE_DOMAIN: string
}

interface Session {
	userId: string
	role: 'admin' | 'user'
	upstreamToken: string
}

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Build per-request because env is only available here.
		// In production you'd cache the parts that don't depend on env across
		// requests (most of them) using module-scope memoization.
		const auth = createAuth<Session>({
			store: createKvSessionStore<Session>(env.SESSIONS),
			cookie: {
				name: 'sid',
				domain: env.SESSION_COOKIE_DOMAIN,
				secure: true,
				sameSite: 'Lax',
			},
			toSession: (r: any) => ({
				userId: r.user.id,
				role: r.user.role,
				upstreamToken: r.access_token,
			}),
			credential: { field: 'upstreamToken' },
		})

		const upstream = createUpstream({
			baseUrl: env.UPSTREAM_BASE_URL,
			credentialFrom: (c) => auth.backendHeaders(c),
		})

		const api = defineRoutes([
			defineRoute({
				method: 'GET',
				path: '/orders',
				guards: [auth.require()],
				handler: async (c) => c.json(await upstream.get(c, '/orders')),
			}),
		])

		// Serve assets from the Workers Sites KV namespace.
		const spa = serveAssets({
			root: '.',
			readBinary: async (path) => {
				const url = new URL(`https://placeholder${path}`)
				const evt = { request: new Request(url) } as unknown as FetchEvent
				const res = await getAssetFromKV(evt, {
					ASSET_NAMESPACE: env.__STATIC_CONTENT,
					mapRequestToAsset: (r: Request) => r,
				})
				return new Uint8Array(await res.arrayBuffer())
			},
		})

		const bff = createBff({
			middleware: [requestId(), accessLog(), errorHandler()],
			auth,
			api,
			spa,
		})

		return bff.fetch(req, env, ctx)
	},
}