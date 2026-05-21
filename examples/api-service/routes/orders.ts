import { defineRoute, type Auth } from '@jayobado/hono-kit'
import { z } from 'zod'
import type { OrderService } from '../services/orders.ts'
import type { Session } from '../auth.ts'

const orderInput = z.object({
	items: z.array(z.object({ sku: z.string(), qty: z.number().min(1) })).min(1),
	total: z.number().nonnegative(),
})

const idParam = z.object({ id: z.string().uuid() })

export const orderRoutes = (auth: Auth<Session>, orders: OrderService) => [
	defineRoute({
		method: 'GET',
		path: '/orders',
		guards: [auth.require()],
		handler: async (c) => {
			const userId = auth.getSession(c)!.userId
			return c.json(await orders.list(userId))
		},
	}),

	defineRoute({
		method: 'GET',
		path: '/orders/:id',
		input: { params: idParam },
		guards: [auth.require()],
		handler: async (c, { params }) => {
			const userId = auth.getSession(c)!.userId
			const order = await orders.get(userId, params.id)
			if (!order) return c.json({ message: 'Not found', code: 404 }, 404)
			return c.json(order)
		},
	}),

	defineRoute({
		method: 'POST',
		path: '/orders',
		input: { body: orderInput },
		// requireRole: only admins can create orders in this example
		guards: [auth.require(), auth.requireRole(s => s.role === 'admin')],
		handler: async (c, { body }) => {
			const userId = auth.getSession(c)!.userId
			const order = await orders.create(userId, body)
			return c.json(order, 201)
		},
	}),

	defineRoute({
		method: 'DELETE',
		path: '/orders/:id',
		input: { params: idParam },
		guards: [auth.require()],
		handler: async (c, { params }) => {
			const userId = auth.getSession(c)!.userId
			await orders.cancel(userId, params.id)
			return c.body(null, 204)
		},
	}),
]