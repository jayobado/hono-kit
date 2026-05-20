# ConnectRPC client via BFF

Use the official `@connectrpc/connect` client with hono-kit's auth and
correlation headers. The BFF holds the session; the Connect client sees
only the headers that `upstream.headers(c)` produces.

## Setup

```ts
// deno.json
{
  "imports": {
    "@connectrpc/connect": "npm:@connectrpc/connect@^2",
    "@connectrpc/connect-node": "npm:@connectrpc/connect-node@^2"
  }
}
```

## BFF route calling a Connect service

```ts
import { defineRoute, defineRoutes, createUpstream } from '@jayobado/hono-kit'
import { createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { OrderService } from './gen/order_connect.ts'  // protoc-gen output

const upstream = createUpstream({
  baseUrl: 'http://internal-rpc',
  credentialFrom: (c) => auth.backendHeaders(c),
})

function transportFor(c: Context) {
  return createConnectTransport({
    baseUrl: 'http://internal-rpc',
    httpVersion: '1.1',
    interceptors: [
      (next) => async (req) => {
        // Inject auth + correlation headers from the BFF's upstream client.
        const headers = upstream.headers(c)
        for (const [k, v] of Object.entries(headers)) {
          req.header.set(k, v)
        }
        return next(req)
      },
    ],
  })
}

const routes = defineRoutes([
  defineRoute({
    method: 'POST',
    path: '/orders',
    input: { body: orderSchema },
    guards: [auth.require()],
    handler: async (c, { body }) => {
      const client = createClient(OrderService, transportFor(c))
      const result = await client.placeOrder({ items: body.items })
      return c.json(result)
    },
  }),
])
```

## Why this works

`upstream.headers(c)` returns the same headers `upstream.get/post/etc` would
attach to a `fetch` call — `Authorization`, `X-Request-Id`, default headers.
The Connect transport doesn't know about hono-kit; it just gets the headers
to send.

## Notes

- **One transport per request.** Don't cache transports across requests — the
  interceptor closes over `c` and would leak.
- **Streaming RPCs work the same way.** The interceptor runs once per call.
- **Errors:** Connect throws its own `ConnectError`. Catch and translate in
  the handler if you want a hono-kit-shape error response.
- **Browser client:** if your SPA also speaks Connect (rare in a BFF setup —
  usually the BFF translates), use `@connectrpc/connect-web` and point its
  `baseUrl` at the BFF, not the internal service.