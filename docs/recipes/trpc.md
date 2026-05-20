# tRPC client via BFF

Use the official `@trpc/client` to call upstream tRPC services. The BFF
attaches auth and correlation headers via a custom fetch.

## Setup

```ts
// deno.json
{
  "imports": {
    "@trpc/client": "npm:@trpc/client@^11"
  }
}
```

## BFF route calling a tRPC service

```ts
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from './gen/router.ts'  // type-only import from upstream
import { defineRoute, defineRoutes, createUpstream } from '@jayobado/hono-kit'

const upstream = createUpstream({
  baseUrl: 'http://internal-trpc',
  credentialFrom: (c) => auth.backendHeaders(c),
})

function clientFor(c: Context) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'http://internal-trpc/trpc',
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...init?.headers, ...upstream.headers(c) },
          }),
      }),
    ],
  })
}

const routes = defineRoutes([
  defineRoute({
    method: 'GET',
    path: '/profile',
    guards: [auth.require()],
    handler: async (c) => {
      const trpc = clientFor(c)
      const profile = await trpc.users.me.query()
      return c.json(profile)
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/orders',
    input: { body: orderSchema },
    guards: [auth.require()],
    handler: async (c, { body }) => {
      const trpc = clientFor(c)
      const order = await trpc.orders.create.mutate(body)
      return c.json(order, 201)
    },
  }),
])
```

## Why this works

`httpBatchLink` accepts a custom `fetch`. We wrap the default with one that
merges in `upstream.headers(c)`. The tRPC client doesn't know about auth;
the fetch wrapper does.

## Sharing types with the upstream

The cleanest pattern is for the upstream tRPC service to publish its
`AppRouter` type. If both are in your monorepo, just `import type` from the
upstream package. If they're separate, ship the router type as a tiny
`@yourorg/trpc-types` package.

## Notes

- **No client caching.** Same reason as Connect — the fetch closure holds
  the request context.
- **Errors:** tRPC throws `TRPCClientError`. Catch in the handler for custom
  responses.
- **WebSocket links:** `wsLink` doesn't take a custom fetch. If you need
  authenticated tRPC subscriptions, terminate the subscription at the BFF
  and forward via your own WebSocket using `createWsHandler` + `createChannels`.