# hono-kit

A toolkit of composable primitives for building [Hono](https://hono.dev)-based
API services and BFFs. Each primitive does one thing; the archetype builders
wire pieces together without hidden behavior.

Designed for two deployment shapes:

- **API service** — backend behind a BFF or other clients
- **BFF (Backend-for-Frontend)** — wraps an SPA, holds the session, talks to
  upstream services with the user's credentials

Targets Deno (primary), Node.js, and Cloudflare Workers.

```ts
import {
  createAuth, createMemoryStore,
  defineRoute, defineRoutes,
  createUpstream,
  createBff,
  serveAssets,
  requestId, errorHandler,
  serveDeno,
} from '@jayobado/hono-kit'
```

## Install

```bash
deno add jsr:@jayobado/hono-kit
```

Or in `deno.json`:

```json
{
  "imports": {
    "@jayobado/hono-kit": "jsr:@jayobado/hono-kit@^0.4"
  }
}
```

## At a glance

```ts
import { Hono } from 'hono'
import {
  createAuth, createMemoryStore,
  defineRoute, defineRoutes,
  createUpstream,
  createBff, serveAssets,
  requestId, accessLog, errorHandler,
  serveDeno,
} from '@jayobado/hono-kit'

type Session = { userId: string; role: 'admin' | 'user'; upstreamToken: string }

const auth = createAuth<Session>({
  store: createMemoryStore<Session>(),
  cookie: { name: 'sid', secure: true, sameSite: 'Lax' },
  toSession: (r: any) => ({
    userId: r.user.id,
    role: r.user.role,
    upstreamToken: r.access_token,
  }),
  credential: { field: 'upstreamToken' },
})

const upstream = createUpstream({
  baseUrl: 'http://internal-api',
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

const spa = serveAssets({ root: './dist' })

const bff = createBff({
  middleware: [requestId(), accessLog(), errorHandler()],
  auth,
  api,
  spa,
  health: { version: '1.0.0' },
})

await serveDeno(bff, { port: 3000 })
```

That's a complete BFF in 40 lines. Login, session, route validation, upstream
forwarding, SPA hosting, and a `/health` endpoint — all explicitly wired,
nothing hidden.

## Mental model
your code
↓
archetype builders     →   createApiApp, createBff
↓                       (thin composers, no hidden behavior)
primitives             →   auth, sessions, routes, upstream, ws, etc.
↓
Hono

Three tiers. The archetype builders are convenience — you can always drop down
to primitives and wire by hand if you want.

## Primitives

### Auth + sessions

`createAuth` is one primitive that handles session lifecycle, cookie
management, upstream credential storage, credential relay, and access guards.
Cookie attributes including `domain` are first-class.

```ts
const auth = createAuth<Session>({
  store: createMemoryStore<Session>(),
  cookie: {
    name: 'admin_sid',
    domain: '.example.com',   // for multi-portal subdomain scoping
    secure: true,
    sameSite: 'Lax',
  },
  toSession: (loginResponse) => ({
    userId: loginResponse.user.id,
    role: loginResponse.user.role,
    upstreamToken: loginResponse.access_token,
  }),
  credential: {
    field: 'upstreamToken',
    header: 'Authorization',
    format: v => `Bearer ${v}`,
  },
  refresh: {
    isExpired: s => Date.now() > s.expiresAt,
    renew: async s => { /* call upstream refresh endpoint */ },
  },
})

// In handlers:
auth.login(c, loginResponse)        // sets cookie, stores session
auth.logout(c)                       // clears cookie + store
auth.getSession(c)                   // typed session or undefined
auth.getToken(c)                     // upstream token convenience
auth.backendHeaders(c)               // { Authorization: 'Bearer ...' }
auth.require()                       // guard: 401 if anonymous
auth.requireRole(s => s.role === 'admin')  // guard: 403 on mismatch
```

Stateless mode (encrypted cookie, no store) is also supported:

```ts
const auth = createAuth<Session>({
  stateless: { secret: Deno.env.get('SESSION_SECRET')! },
  // ...same other options
})
```

### Session stores

- `createMemoryStore<T>()` — in-process, suitable for single-instance VPS
- `createKvSessionStore<T>(kv)` — Cloudflare KV (`@jayobado/hono-kit/cf-stores`)
- `createDurableObjectSessionStore<T>(ns)` — Cloudflare DO (`@jayobado/hono-kit/cf-stores`)

Implement `SessionStore<T>` for custom backends (Redis, Postgres, etc).

### Routes

`defineRoute` declares a single route with optional input schemas (body,
query, params) and guards. `defineRoutes` composes an array of descriptors
into a mountable Hono sub-app.

```ts
import { z } from 'zod'

const orderSchema = z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number() })),
  total: z.number(),
})

const routes = defineRoutes([
  defineRoute({
    method: 'POST',
    path: '/orders',
    input: { body: orderSchema },
    guards: [auth.require(), auth.requireRole(s => s.role === 'admin')],
    handler: async (c, { body }) => {
      // body is typed { items: [...], total: number }
      return c.json(await db.createOrder(body), 201)
    },
  }),
])

app.route('/api', routes)
```

Works with any [Standard Schema](https://standardschema.dev) implementation —
Zod, Valibot, ArkType, etc.

### Upstream

`createUpstream` builds outbound requests with credentials, correlation
headers, and JSON defaults.

```ts
const upstream = createUpstream({
  baseUrl: 'http://internal-api',
  credentialFrom: (c) => auth.backendHeaders(c),
  defaultHeaders: { 'X-Service': 'admin-bff' },
  requestIdHeader: 'X-Request-Id',
  timeout: 10_000,
})

// In handlers:
const orders = await upstream.get<Order[]>(c, '/orders')      // throws UpstreamError on !ok
const created = await upstream.post<Order>(c, '/orders', body)
const result = await upstream.fetch(c, '/orders', { method: 'GET' })  // low-level
return await upstream.proxy(c, '/orders')                     // forward + strip cookie

// For tRPC / Connect / GraphQL / gRPC clients:
const headers = upstream.headers(c)  // pass to any client's transport
```

Errors throw `UpstreamError` carrying the status, parsed body, and original Response.

### SPA modes

Three serving strategies:

```ts
// Dev mode — lazy transpile, HMR, file watch (Deno only)
const dev = createDevServer({
  root: './client',
  importMap: './deno.json',
  compilerOptions: { jsxImportSource: 'vue' },  // for lolo-ui
})
// ...later: dev.dispose() on shutdown

// Transpile mode — eager warm, no HMR, pre-gzipped (Deno VPS prod)
const t = await createTranspileServer({
  root: './client',
  importMap: './deno.json',
})

// Build mode — pre-bundled static files (works on any runtime)
const assets = serveAssets({
  root: './dist',
  manifest: JSON.parse(await Deno.readTextFile('./dist/manifest.json')),
})
```

`createBff({ spa: dev.app })`, `createBff({ spa: t.app })`, or
`createBff({ spa: assets })` — same shape.

Dev and transpile modes work with **TS + JSX** stacks (lolo-ui, React, Solid,
Preact, Vue JSX). For Vue SFCs, Svelte, or anything needing framework-specific
compilation, build with the framework's tooling and use `serveAssets`.

### Build

```ts
import { build } from '@jayobado/hono-kit'

await build({
  entry: './client/main.tsx',
  outDir: './dist',
  importMap: './deno.json',
  minify: true,
})

// Produces:
//   dist/main.abc12345.js
//   dist/manifest.json   { "main.js": "main.abc12345.js", ... }
//   dist/index.html      (verbatim, with __ASSET() placeholders)
//   dist/<other static files>
```

In your `index.html`, reference assets with placeholders:

```html
<link rel="stylesheet" href='__ASSET("style.css")__'>
<script type="module" src='__ASSET("main.js")__'></script>
```

`serveAssets` substitutes these at serve time using the manifest.

### WebSocket

`createChannels` manages connection state and broadcast. `createWsHandler`
upgrades requests and runs lifecycle hooks. They're independent — use one
without the other.

```ts
const channels = createChannels()

const ws = createWsHandler({
  authenticate: (c) => auth.getSession(c) ?? false,
  onConnect: (conn) => {
    channels.add(conn)
    channels.join(conn, 'orders')
  },
  onMessage: (conn, data) => {
    channels.broadcast('chat', { from: conn.id, data })
  },
  onClose: (conn) => channels.remove(conn),
  pingInterval: 30_000,
})

app.get('/ws', ws)

// Bus → WS fanout (explicit, traceable):
events.on('orders', msg => channels.broadcast('orders', msg))
```

### Events

In-process pub/sub with SSE support:

```ts
const events = createEventBus()
events.on('orders', msg => console.log('order:', msg))
events.emit('orders', { id: 'o1' })

app.get('/events/orders', c => events.stream(c, 'orders'))
```

For multi-instance pubsub (Redis, etc), write a thin wrapper that publishes
to your transport on `emit` and subscribes back to the bus.

### Middleware

```ts
import {
  requestId, accessLog, errorHandler, securityHeaders, compress,
} from '@jayobado/hono-kit'

app.use('*', requestId())
app.use('*', accessLog())
app.use('*', errorHandler())
app.use('*', securityHeaders())
app.use('*', compress())
```

### Health

```ts
import { mountHealth } from '@jayobado/hono-kit'

mountHealth(app, {
  version: '1.2.3',
  checks: {
    db: () => db.ping(),
    cache: () => redis.ping(),
  },
})

// GET /health   → { status: 'ok', version: '1.2.3' }
// GET /ready    → 200 if all checks pass, 503 otherwise
// GET /version  → { version: '1.2.3' }
```

The archetype builders accept `health` directly.

### Runtime helpers

```ts
import { serveDeno, serveNode, onShutdown } from '@jayobado/hono-kit'

// Register cleanup hooks
onShutdown(() => dev.dispose())
onShutdown(() => store.dispose())
onShutdown(() => db.close())

// Serve — drains hooks on SIGINT/SIGTERM
const server = await serveDeno(app, { port: 3000 })
// or
const server = await serveNode(app, { port: 3000 })

await server.finished  // wait for graceful stop
```

For Cloudflare Workers, no runtime helper is needed:

```ts
export default { fetch: app.fetch }
```

## Archetype composers

`createApiApp` and `createBff` are thin composers — they only wire what you
pass them. No surprise middleware, no auto-mounted CORS, no hidden behavior.

```ts
// API service
const app = createApiApp({
  middleware: [requestId(), accessLog(), errorHandler()],
  auth,
  routes: defineRoutes([...]),
  routesPrefix: '/',           // default '/'
  health: { version: '1.0.0' },
})

// BFF
const bff = createBff({
  middleware: [requestId(), accessLog(), errorHandler()],
  auth,
  api: defineRoutes([...]),    // mounted at apiPrefix
  apiPrefix: '/api',           // default '/api'
  spa,                          // mounted at '/' last; api/health/ws take precedence
  ws: { path: '/ws', handler: createWsHandler({ ... }) },
  health: { version: '1.0.0' },
})
```

Both return a Hono app you can extend directly (`bff.get(...)`, `bff.use(...)`).

## Deployment patterns

### Single Deno VPS

```ts
// main.ts
import { serveDeno, onShutdown } from '@jayobado/hono-kit'

const dev = isDev
  ? createDevServer({ root: './client', importMap: './deno.json' })
  : null
const spa = dev?.app ?? serveAssets({ root: './dist' })

const bff = createBff({ auth, api, spa, /* ... */ })

if (dev) onShutdown(() => dev.dispose())
await serveDeno(bff, { port: 3000 })
```

### Multi-portal (admin + user from one VPS)

```ts
// admin-bff.ts (run as one process)
const auth = createAuth({
  cookie: { name: 'admin_sid', domain: '.example.com' },
  // ...
})
await serveDeno(createBff({ auth, api, spa }), { port: 3001 })

// user-bff.ts (run as a second process)
const auth = createAuth({
  cookie: { name: 'user_sid', domain: '.example.com' },
  // ...
})
await serveDeno(createBff({ auth, api, spa }), { port: 3002 })
```

Different cookie names prevent session bleed; nginx routes by subdomain.

### Cloudflare Workers

```ts
// worker.ts
import { createKvSessionStore } from '@jayobado/hono-kit/cf-stores'

export default {
  async fetch(req: Request, env: Env) {
    const auth = createAuth({
      store: createKvSessionStore(env.SESSIONS),
      // ...
    })
    const bff = createBff({ auth, api, spa: serveAssets({ root: './dist' }) })
    return bff.fetch(req, env)
  },
}
```

CF requires pre-built assets — use `build` mode, not dev or transpile.

## Frontend stack compatibility

| Stack                    | Dev mode | Transpile mode | Build mode |
|--------------------------|----------|----------------|------------|
| lolo-ui (Vue JSX)        | ✓        | ✓              | ✓          |
| React + Vite             | ~ (TS only) | ~ (TS only) | ✓          |
| Solid                    | ✓        | ✓              | ✓          |
| Preact                   | ✓        | ✓              | ✓          |
| Vue SFCs (`.vue` files)  | ✗        | ✗              | ✓          |
| Svelte                   | ✗        | ✗              | ✓          |
| Plain HTML + TS modules  | ✓        | ✓              | ✓          |
| Static site (any SSG)    | —        | —              | ✓          |

For stacks needing framework-specific compilation, build with the framework's
tooling and use `serveAssets` to serve the dist folder. The auth, upstream,
and routes layers don't care what's in the SPA.

## Design principles

1. **Portable by default, runtime-specific by opt-in.** Primitives that need
   Deno (dev SPA, transpile mode) say so. Build mode and the rest work anywhere.

2. **No god-functions.** Each composer only does what you pass it. No hidden
   middleware, no auto-mounted CORS, no surprise behavior.

3. **Descriptors over registration.** `defineRoute` returns data; `defineRoutes`
   composes data into a Hono app. Future OpenAPI generation, route listing, and
   contract testing fall out of this for free.

4. **One protocol, many clients.** This kit ships HTTP/JSON and a header
   builder. For ConnectRPC, tRPC, GraphQL, or gRPC, use the official client
   and pass `upstream.headers(c)` to its transport.

5. **Cookie-only auth.** Tokens never reach the browser. The BFF holds the
   session; the client has only a `httpOnly; secure; sameSite` cookie.

## License

MIT. See [LICENSE](LICENSE).