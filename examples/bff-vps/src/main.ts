import { Hono } from 'hono'
import {
	createBff,
	createDevServer,
	createTranspileServer,
	serveAssets,
	requestId,
	accessLog,
	errorHandler,
	defineRoutes,
	serveDeno,
	onShutdown,
} from '@jayobado/hono-kit'

import { auth } from './auth.ts'
import { upstream } from './upstream.ts'
import { orderRoutes } from './routes/orders.ts'

const mode = (Deno.env.get('MODE') ?? 'dev') as 'dev' | 'transpile' | 'build'
const port = Number(Deno.env.get('PORT') ?? '3001')

// Build the SPA handler based on mode.
let spa: Hono
if (mode === 'dev') {
	const dev = createDevServer({
		root: './client',
		importMap: './deno.json',
	})
	spa = dev.app
	onShutdown(() => dev.dispose())
} else if (mode === 'transpile') {
	const t = await createTranspileServer({
		root: './client',
		importMap: './deno.json',
	})
	spa = t.app
} else {
	const manifestText = await Deno.readTextFile('./dist/manifest.json')
	spa = serveAssets({
		root: './dist',
		manifest: JSON.parse(manifestText),
	})
}

// Login route — the BFF authenticates against the upstream API service.
const loginApp = new Hono()
loginApp.post('/login', async (c) => {
	const body = await c.req.json()
	const res = await fetch(`${upstream.headers(c)['X-Upstream-Base'] ?? 'http://localhost:3000'}/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		const err = await res.json()
		return c.json(err, res.status as 401)
	}
	const loginResponse = await res.json()
	await auth.login(c, loginResponse)
	return c.json({ ok: true })
})

loginApp.post('/logout', async (c) => {
	await auth.logout(c)
	return c.json({ ok: true })
})

// Compose the BFF.
const bff = createBff({
	middleware: [requestId(), accessLog(), errorHandler()],
	auth,
	api: defineRoutes(orderRoutes(auth, upstream)),
	apiPrefix: '/api',
	spa,
	health: { version: '0.1.0' },
})

// Mount the login app at /auth (sits between auth middleware and api).
bff.route('/auth', loginApp)

await serveDeno(bff, { port })