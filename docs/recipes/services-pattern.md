# Services pattern

Routes should be thin: extract input, call a service, return the result.
Business logic lives in **service functions** that are testable without Hono.

This is a documented pattern, not a hono-kit primitive. There's no
`defineService` or `defineDomain` — just a convention.

## Shape

```
src/
  services/
    orders.ts       ← business logic, pure-ish, testable
    users.ts
  routes/
    orders.ts       ← thin HTTP layer, calls services
    users.ts
  main.ts            ← wires it all up
```

## A service

A service is a function returning an object. Dependencies are injected.

```ts
// services/orders.ts
import type { Db } from './db.ts'
import type { EventBus } from '@jayobado/hono-kit'

export interface OrderInput {
  items: { sku: string; qty: number }[]
  total: number
}

export interface OrderService {
  list(userId: string, cursor?: string): Promise<Order[]>
  create(userId: string, input: OrderInput): Promise<Order>
  cancel(userId: string, orderId: string): Promise<void>
}

export function createOrderService(deps: {
  db: Db
  events: EventBus
}): OrderService {
  return {
    async list(userId, cursor) {
      return deps.db.query(
        `select * from orders where user_id = $1 and id > $2 order by id limit 20`,
        userId,
        cursor ?? '',
      )
    },

    async create(userId, input) {
      const order = await deps.db.insert('orders', {
        userId,
        items: input.items,
        total: input.total,
        status: 'pending',
      })
      deps.events.emit('orders.created', order)
      return order
    },

    async cancel(userId, orderId) {
      await deps.db.execute(
        `update orders set status = 'cancelled' where id = $1 and user_id = $2`,
        orderId,
        userId,
      )
      deps.events.emit('orders.cancelled', { orderId, userId })
    },
  }
}
```

The service takes deps, returns methods. It doesn't know about Hono,
`Context`, request headers, or response shapes. It can be tested with a
mock `Db` and a real `createEventBus()`.

## A route file using the service

```ts
// routes/orders.ts
import { defineRoute, type Auth } from '@jayobado/hono-kit'
import { z } from 'zod'
import type { OrderService } from '../services/orders.ts'
import type { Session } from '../types.ts'

const createOrderSchema = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number() })),
  total: z.number(),
})

const cursorSchema = z.object({ cursor: z.string().optional() })
const idParam = z.object({ id: z.string().uuid() })

export const orderRoutes = (auth: Auth<Session>, orders: OrderService) => [
  defineRoute({
    method: 'GET',
    path: '/orders',
    input: { query: cursorSchema },
    guards: [auth.require()],
    handler: async (c, { query }) => {
      const userId = auth.getSession(c)!.userId
      return c.json(await orders.list(userId, query.cursor))
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/orders',
    input: { body: createOrderSchema },
    guards: [auth.require()],
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
```

Routes are thin: extract `userId` from session, validate input via the
schema, call the service, return the result. No business logic in the route.

## Wiring in main.ts

```ts
// main.ts
import { createAuth, defineRoutes, createApiApp, serveDeno } from '@jayobado/hono-kit'
import { createOrderService } from './services/orders.ts'
import { orderRoutes } from './routes/orders.ts'
import { db } from './db.ts'
import { events } from './events.ts'

const auth = createAuth<Session>({ /* ... */ })
const orderService = createOrderService({ db, events })

const app = createApiApp({
  auth,
  routes: defineRoutes([
    ...orderRoutes(auth, orderService),
    // ...other route modules
  ]),
})

await serveDeno(app, { port: 3000 })
```

## Testing services

Since services don't depend on Hono, tests are straightforward:

```ts
// services/orders.test.ts
import { assertEquals } from '@std/assert'
import { createOrderService } from './orders.ts'

Deno.test('order.create emits orders.created', async () => {
  const events: any[] = []
  const fakeBus = {
    emit: (channel: string, data: unknown) => events.push({ channel, data }),
    on: () => () => {},
    stream: () => new Response(),
  }
  const fakeDb = {
    insert: async (_table: string, row: any) => ({ id: 'o1', ...row }),
  }

  const orders = createOrderService({ db: fakeDb as any, events: fakeBus as any })
  await orders.create('u1', { items: [{ sku: 'a', qty: 1 }], total: 10 })

  assertEquals(events.length, 1)
  assertEquals(events[0].channel, 'orders.created')
})
```

No Hono, no request mocking, no middleware stack. Just a function call
with fake deps.

## Why not a primitive?

I considered shipping `defineService` or `defineDomain`. But:

1. **It would force a shape.** Services in different apps want different
   shapes — some are object-returning factories, some are classes, some are
   plain functions. Forcing one shape limits flexibility.

2. **Nothing in hono-kit needs to know.** The kit's job ends at "give me an
   `OrderService` and I'll call its methods from routes." A primitive that
   doesn't enforce or enable anything is just docs in code.

3. **You can always add one yourself.** A 10-line `defineDomain` factory
   in your own app is fine. Patterns belong to apps; primitives belong to
   the framework.

The convention works. Don't shop for a primitive.