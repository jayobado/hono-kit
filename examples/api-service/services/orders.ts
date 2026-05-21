// Pure business logic. No Hono, no HTTP. Trivially unit-testable.

export interface Order {
	id: string
	userId: string
	items: { sku: string; qty: number }[]
	total: number
	status: 'pending' | 'paid' | 'cancelled'
	createdAt: number
}

export interface OrderInput {
	items: { sku: string; qty: number }[]
	total: number
}

export interface OrderService {
	list(userId: string): Promise<Order[]>
	get(userId: string, id: string): Promise<Order | undefined>
	create(userId: string, input: OrderInput): Promise<Order>
	cancel(userId: string, id: string): Promise<void>
}

export function createOrderService(deps: {
	store: Map<string, Order>
}): OrderService {
	return {
		list(userId) {
			const orders: Order[] = []
			for (const o of deps.store.values()) {
				if (o.userId === userId) orders.push(o)
			}
			return Promise.resolve(orders)
		},

		get(userId, id) {
			const order = deps.store.get(id)
			if (!order || order.userId !== userId) return Promise.resolve(undefined)
			return Promise.resolve(order)
		},

		create(userId, input) {
			const order: Order = {
				id: crypto.randomUUID(),
				userId,
				items: input.items,
				total: input.total,
				status: 'pending',
				createdAt: Date.now(),
			}
			deps.store.set(order.id, order)
			return Promise.resolve(order)
		},

		cancel(userId, id) {
			const order = deps.store.get(id)
			if (order && order.userId === userId) {
				order.status = 'cancelled'
			}
			return Promise.resolve()
		},
	}
}