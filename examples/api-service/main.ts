import {
	createApiApp,
	defineRoutes,
	requestId,
	accessLog,
	errorHandler,
	serveDeno,
} from '@jayobado/hono-kit'

import { auth } from './auth.ts'
import { createOrderService } from './services/orders.ts'
import { orderRoutes } from './routes/orders.ts'
import { loginRoute } from './routes/login.ts'

// Wire up dependencies (in a real app these'd come from a DB layer, etc).
const orderService = createOrderService({
	// In-memory store for the example. Swap for a real DB.
	store: new Map(),
})

const app = createApiApp({
	middleware: [requestId(), accessLog(), errorHandler()],
	auth,
	routes: defineRoutes([
		loginRoute(auth),
		...orderRoutes(auth, orderService),
	]),
	health: {
		version: '1.0.0',
		checks: {
			// In a real app: db.ping(), redis.ping(), etc.
			memory: () => Promise.resolve(true),
		},
	},
})

await serveDeno(app, { port: 3000 })