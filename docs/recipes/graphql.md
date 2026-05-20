# GraphQL client via BFF

Forward authenticated GraphQL operations from the BFF to an upstream
GraphQL service. The integration is the same regardless of client library
(graphql-request, urql, Apollo) — attach `upstream.headers(c)` and go.

## Setup

```ts
// deno.json
{
  "imports": {
    "graphql-request": "npm:graphql-request@^7"
  }
}
```

`graphql-request` is the smallest choice and works well in a BFF where you
just need to send operations, not manage a cache.

## BFF route calling a GraphQL upstream

```ts
import { GraphQLClient, gql } from 'graphql-request'
import { defineRoute, defineRoutes, createUpstream } from '@jayobado/hono-kit'

const upstream = createUpstream({
  baseUrl: 'http://internal-graphql',
  credentialFrom: (c) => auth.backendHeaders(c),
})

const GET_ORDERS = gql`
  query GetOrders($cursor: String, $limit: Int!) {
    orders(cursor: $cursor, limit: $limit) {
      nodes { id status total }
      pageInfo { endCursor hasNextPage }
    }
  }
`

const routes = defineRoutes([
  defineRoute({
    method: 'GET',
    path: '/orders',
    input: { query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().default(20) }) },
    guards: [auth.require()],
    handler: async (c, { query }) => {
      const client = new GraphQLClient('http://internal-graphql/graphql', {
        headers: upstream.headers(c),
      })
      const data = await client.request(GET_ORDERS, query)
      return c.json(data)
    },
  }),
])
```

## Why this works

GraphQL clients all take a headers option or a custom fetch. We pass our
auth + correlation headers in one shot.

## Proxy pattern (when the BFF doesn't transform)

If the BFF is purely passing GraphQL operations through (no shaping, no
aggregation), use `upstream.proxy(c)` and skip the GraphQL client entirely:

```ts
defineRoute({
  method: 'POST',
  path: '/graphql',
  guards: [auth.require()],
  handler: (c) => upstream.proxy(c, '/graphql'),
})
```

The body, query, and headers (minus cookie) all forward as-is.

## Notes

- **Persisted queries:** if your upstream uses APQ, the proxy pattern works
  without any changes — the hash request flows through.
- **Subscriptions:** websocket subscriptions need to be re-established at the
  BFF. Use `createWsHandler` to terminate the client connection and forward
  events via a server-side GraphQL subscription client (e.g. `graphql-ws`).
- **Caching:** don't cache the GraphQLClient instance across requests if
  headers depend on the user. Construct per-request.