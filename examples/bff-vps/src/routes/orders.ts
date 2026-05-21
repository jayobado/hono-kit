import { defineRoute, type Auth, type Upstream } from '@jayobado/hono-kit'
import type { Session } from '../auth.ts'

// BFF routes are typically thin: forward to upstream, optionally shape.
export const orderRoutes = (auth: Auth<Session>, upstream: Upstream) => [
	defineRoute({
		method: 'GET',
		path: '/orders',
		guards: [auth.require()],
		handler: async (c) => {
			const orders = await upstream.get(c, '/orders')
			return c.json({ orders, fetchedAt: Date.now() })
		},
	}),

	defineRoute({
		method: 'POST',
		path: '/orders',
		guards: [auth.require()],
		handler: async (c) => {
			const body = await c.req.json()
			const order = await upstream.post(c, '/orders', body)
			return c.json(order, 201)
		},
	}),

	// Or a pure passthrough for routes that don't need shaping:
	defineRoute({
		method: 'GET',
		path: '/orders/:id',
		guards: [auth.require()],
		handler: (c) => upstream.proxy(c, `/orders/${c.req.param('id')}`),
	}),
]