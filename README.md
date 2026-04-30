# hono-kit

A full-stack toolkit built on Hono. Serves SPAs, APIs, server-rendered pages, and WebSocket connections from a single `createServer()` call. Runs on Deno, Node, and Cloudflare Workers.

## What it provides

- **SPA serving** — on-the-fly TypeScript transpilation, import rewriting, HMR, SPA fallback
- **API layer** — REST routes with optional tRPC, CORS, auth guards
- **Pages / BFF** — server-rendered HTML, backend-for-frontend data aggregation
- **Auth** — session stores, httpOnly cookies, encrypted stateless sessions, token relay to backends
- **WebSocket** — connection management, channels, auth before upgrade
- **Events** — pub/sub event bus, SSE streaming, broadcast adapter for horizontal scaling
- **Build** — production bundler with content hashing
- **Runtime agnostic** — Deno, Node, Cloudflare Workers through adapter pattern

## Requirements

- Deno 1.40+ (primary), Node 18+ (via adapter), or Cloudflare Workers
- Hono 4.12+

## Installation

### Deno
```sh
deno add jsr:@jayobado/hono-kit
```

### Node
```sh
npm install @jayobado/hono-kit hono @hono/node-server
```

### Cloudflare Workers
```sh
npm install @jayobado/hono-kit hono
```

---

## Quick start

```typescript
import { createServer, createAuth, createMemoryStore } from '@jayobado/hono-kit'

const auth = createAuth({
  store: createMemoryStore(),
  cookie: { secure: false },
  extract: (res: any) => ({
    userId: res.user.id,
    email: res.user.email,
    role: res.user.role,
  }),
})

await createServer({
  port: 3000,

  spa: {
    root: './client',
    importMap: './deno.json',
  },

  api: {
    prefix: '/api',
    middleware: [auth.middleware()],
    routes: (app) => {
      app.post('/auth/login', async (c) => {
        const { email, password } = await c.req.json()
        // authenticate against your backend
        const session = await auth.login(c, { user: { id: '1', email, role: 'admin' } })
        return c.json({ userId: session.userId, email: session.email })
      })

      app.post('/auth/logout', async (c) => {
        await auth.logout(c)
        return c.json({ ok: true })
      })

      app.get('/me', auth.require(), (c) => {
        return c.json(auth.getSession(c))
      })
    },
  },
})
```

```json
{
  "tasks": {
    "dev": "deno run --watch --allow-all server.ts",
    "start": "ENV=production deno run --allow-all server.ts",
    "build": "deno run --allow-all scripts/build.ts"
  }
}
```

```bash
deno task dev
```

---

## `createServer()`

Composes all layers into a single Hono app and starts the server.

```typescript
await createServer({
  // ── Runtime ─────────────────────────────────────────────────────────
  port: 3000,
  host: 'localhost',
  adapter: 'deno',              // 'deno' | 'node' | 'cloudflare' | RuntimeAdapter

  // ── Global middleware ───────────────────────────────────────────────
  middleware: [rateLimiter],
  cors: ['https://myapp.com'],  // or CorsOptions object

  // ── API layer ───────────────────────────────────────────────────────
  api: {
    prefix: '/api',
    cors: ['https://myapp.com'],
    middleware: [auth.middleware()],
    routes: (app) => { ... },
  },

  // ── Pages / BFF ─────────────────────────────────────────────────────
  pages: (app) => {
    app.get('/report/:id', async (c) => {
      const data = await fetchReport(c.req.param('id'))
      return c.html(renderReport(data))
    })
  },

  // ── SPA ─────────────────────────────────────────────────────────────
  spa: {
    root: './client',
    importMap: './deno.json',
    strategy: 'lazy',           // 'lazy' | 'eager' | 'build'
    hmr: true,
    compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' },
  },

  // ── Static assets ───────────────────────────────────────────────────
  assets: './public',           // or { root: './public', prefix: '/static', maxAge: 86400 }

  // ── WebSocket ───────────────────────────────────────────────────────
  ws: {
    path: '/ws',
    authenticate: async (c) => getSession(c) || false,
    onConnect: (conn, channels) => { ... },
    onMessage: (conn, data, channels) => { ... },
    onClose: (conn) => { ... },
  },
})
```

### Runtime detection

If `adapter` is omitted, the runtime is auto-detected. You can also pass a custom `RuntimeAdapter` object.

---

## `createApp()`

Synchronous version for Cloudflare Workers. Returns the Hono app directly without starting a server.

```typescript
import { createApp } from '@jayobado/hono-kit'

const app = createApp({
  api: {
    prefix: '/api',
    routes: (app) => { ... },
  },
})

export default app
```

---

## SPA serving

### Transpilation strategies

| Strategy | When | What happens |
|---|---|---|
| `lazy` | Development | Transpiles on first request, caches in memory. HMR enabled by default. |
| `eager` | Production (Deno/Node) | Transpiles all files at startup before accepting requests. |
| `build` | Production (Workers/static) | Serves pre-built files only. No transpiler needed at runtime. |

### Import resolution

Import specifiers are rewritten server-side. Versions are resolved from `deno.lock`.

```typescript
// Source
import { signal } from '@jayobado/lolo-ui'

// Served to browser as
import { signal } from '/jsr/@jayobado/lolo-ui/0.1.8/mod.ts'
```

JSR dependencies are fetched from `jsr.io`, transpiled, and cached. npm dependencies are served via `esm.sh`. Versioned paths are served with `Cache-Control: immutable`.

### Compatible frameworks

| Framework | `compilerOptions` needed |
|---|---|
| lolo-ui | No |
| vue-toolkit | No |
| React | `jsx: 'react-jsx'`, `jsxImportSource: 'react'` |
| Solid | `jsx: 'react-jsx'`, `jsxImportSource: 'solid-js/h'` |
| Preact | `jsx: 'react-jsx'`, `jsxImportSource: 'preact'` |

### HMR

Enabled automatically when strategy is `lazy`. Injects a WebSocket client into HTML responses.

| Change | Behaviour |
|---|---|
| `.css` | Stylesheet reload |
| `.ts` / `.tsx` | Cache invalidated, page reload |
| `.html` | Full page reload |

---

## Auth

### `createAuth()`

Creates a typed auth handler with login, logout, middleware, and guards.

```typescript
interface MySession {
  userId: string
  email: string
  role: 'admin' | 'user'
  token: string
  tokenExpiresAt: number
}

const auth = createAuth<MySession>({
  store: createMemoryStore<MySession>(),
  cookie: { secure: true, maxAge: 60 * 60 * 8 },
  credential: { field: 'token' },

  extract: (res: any) => ({
    userId: res.user.id,
    email: res.user.email,
    role: res.user.role,
    token: res.accessToken,
    tokenExpiresAt: Date.now() + res.expiresIn * 1000,
  }),

  refresh: {
    isExpired: (s) => Date.now() > s.tokenExpiresAt - 30_000,
    renew: async (s) => {
      const res = await fetch('http://auth-svc:4000/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
      })
      if (!res.ok) throw new Error('refresh failed')
      const data = await res.json()
      return { ...s, token: data.accessToken, tokenExpiresAt: Date.now() + data.expiresIn * 1000 }
    },
  },
})
```

### Methods

| Method | Description |
|---|---|
| `auth.login(c, backendResponse)` | Extracts session, stores it, sets httpOnly cookie |
| `auth.logout(c)` | Deletes session, clears cookie |
| `auth.middleware()` | Resolves cookie → session on every request, auto-refreshes tokens |
| `auth.getSession(c)` | Returns typed session or `undefined` |
| `auth.getToken(c)` | Returns the backend credential value |
| `auth.backendHeaders(c)` | Returns `{ Authorization: 'Bearer ...' }` for proxying to backends |
| `auth.require()` | Guard middleware — rejects unauthenticated requests with 401 |
| `auth.requireRole(check, msg?)` | Guard middleware — rejects with 403 if `check(session)` returns false |

### Stateless sessions

No server-side store. Session data is AES-GCM encrypted in the cookie itself.

```typescript
const auth = createAuth<MySession>({
  stateless: { secret: Deno.env.get('SESSION_SECRET')! },
  extract: (res: any) => ({ ... }),
})
```

### Backend credential relay

The browser never sees backend tokens. The toolkit stores them in the session and injects them on outgoing requests.

```typescript
const auth = createAuth<MySession>({
  store: createMemoryStore(),
  credential: { field: 'token' },
  extract: (res: any) => ({ ... }),
})

// In routes
app.get('/orders', async (c) => {
  const res = await fetch('http://order-svc:4001/orders', {
    headers: auth.backendHeaders(c),
  })
  return c.json(await res.json())
})
```

Custom credential format:

```typescript
credential: {
  field: 'apiKey',
  header: 'X-API-Key',
  format: (v) => v,
}
```

### Session stores

| Store | Ships with | Persistence |
|---|---|---|
| `createMemoryStore()` | Core | None — lost on restart |
| Stateless (encrypted cookie) | Core | Stateless — no server store |
| Deno KV | `adapters/deno` | Persistent |
| Redis | User-land | Persistent |
| Cloudflare KV | `adapters/cloudflare` | Persistent |

All stores implement `SessionStore<T>`:

```typescript
interface SessionStore<T> {
  get: (sid: string) => Promise<T | undefined>
  set: (sid: string, data: T, ttl?: number) => Promise<void>
  delete: (sid: string) => Promise<void>
  touch?: (sid: string, ttl?: number) => Promise<void>
}
```

---

## API layer

The API layer is plain Hono routes. Bring your own backend protocol.

### REST

```typescript
api: {
  prefix: '/api',
  routes: (app) => {
    app.get('/users/:id', async (c) => {
      const user = await db.query('SELECT * FROM users WHERE id = ?', [c.req.param('id')])
      return c.json(user)
    })
  },
}
```

### tRPC

```typescript
import { trpcServer } from '@hono/trpc-server'

api: {
  prefix: '/api',
  routes: (app) => {
    app.use('/trpc/*', trpcServer({
      router: appRouter,
      createContext: (_opts, c) => ({
        session: auth.getSession(c),
      }),
    }))
  },
}
```

### Gateway — proxying to backend services

```typescript
api: {
  prefix: '/api',
  middleware: [auth.middleware()],
  routes: (app) => {
    // REST backend
    app.get('/orders', async (c) => {
      const res = await fetch('http://order-svc:4001/orders', {
        headers: auth.backendHeaders(c),
      })
      return c.json(await res.json())
    })

    // Connect-RPC backend
    app.get('/users/:id', async (c) => {
      const client = createConnectClient(UserService, {
        baseUrl: 'http://user-svc:4000',
        headers: auth.backendHeaders(c),
      })
      return c.json(await client.getUser({ id: c.req.param('id') }))
    })

    // Aggregation — multiple backends, one response
    app.get('/dashboard', async (c) => {
      const [profile, orders, notifications] = await Promise.all([
        users.getProfile({ userId: auth.getSession(c)!.userId }),
        orders.listRecent({ userId: auth.getSession(c)!.userId }),
        fetch('http://notify-svc:4002/unread', { headers: auth.backendHeaders(c) }).then(r => r.json()),
      ])
      return c.json({ profile, orders, notifications })
    })
  },
}
```

---

## WebSocket

### Connection management

```typescript
ws: {
  path: '/ws',
  authenticate: async (c) => {
    const session = auth.getSession(c)
    if (!session) return false
    return session
  },
  onConnect: (conn, channels) => {
    channels.join(`org:${conn.session.orgId}`)
    channels.join(`user:${conn.session.userId}`)
  },
  onMessage: (conn, data, channels) => {
    if (data.type === 'subscribe') channels.join(data.channel)
    if (data.type === 'message') {
      channels.broadcast(data.channel, {
        from: conn.session.email,
        body: data.body,
      }, conn.id)
    }
  },
  onClose: (conn) => {
    console.log(`${conn.session.email} disconnected`)
  },
}
```

### Heartbeat

Ping/pong keeps connections alive and detects stale clients:

```typescript
ws: {
  ping: { interval: 30_000, timeout: 10_000 },
}
```

---

## Events

### Event bus

Decouples "something happened" from "who needs to know." API routes emit events, the bus routes them to WebSocket and SSE clients.

```typescript
import { createServer, createEventBus } from '@jayobado/hono-kit'

const events = createEventBus()

await createServer({
  ws: {
    path: '/ws',
    events,
    authenticate: async (c) => auth.getSession(c) || false,
    onConnect: (conn, channels) => {
      channels.join(`user:${conn.session.userId}`)
    },
  },

  api: {
    routes: (app) => {
      app.post('/orders', async (c) => {
        const order = await createOrder(c)
        events.emit(`user:${order.userId}`, { type: 'order:created', order })
        return c.json(order)
      })
    },
  },
})
```

### SSE streaming

Lightweight alternative to WebSocket for server-to-client only:

```typescript
api: {
  routes: (app) => {
    app.get('/events/:channel', (c) => {
      return events.stream(c, c.req.param('channel'))
    })
  },
}
```

Client:
```typescript
const es = new EventSource('/api/events/user:123')
es.onmessage = (e) => console.log(JSON.parse(e.data))
```

### Horizontal scaling

Default is in-process. Pass a `BroadcastAdapter` for multi-process:

```typescript
const events = createEventBus(redisBroadcastAdapter)
```

```typescript
interface BroadcastAdapter {
  publish: (channel: string, data: unknown) => Promise<void>
  subscribe: (channel: string, handler: (data: unknown) => void) => Promise<void>
  unsubscribe: (channel: string) => Promise<void>
}
```

---

## Build

Production bundler for static deployment.

```typescript
import { build } from '@jayobado/hono-kit'

await build({
  entry: './client/app.ts',
  outDir: './dist',
  importMap: './deno.json',
  minify: true,
})
```

Output:

dist/
├── index.html          ← script tag rewritten to hashed bundle
├── app.a1b2c3d4.js     ← bundled, content-hashed
├── styles.css          ← copied
└── assets/
└── fonts/          ← copied

---

## Middleware

Built-in middleware applied automatically:

```typescript
import {
  requestId,        // crypto.randomUUID() per request
  errorHandler,     // catches errors, returns 500
  securityHeaders,  // X-Frame-Options, X-Content-Type-Options, etc.
  accessLog,        // method, path, status, duration
  compress,         // gzip for text responses
} from '@jayobado/hono-kit'
```

Custom middleware:

```typescript
await createServer({
  middleware: [myCustomMiddleware],
  api: {
    middleware: [apiOnlyMiddleware],
  },
})
```

---

## Logging

Buffered file logger with daily rotation. No filesystem I/O on the request path.

```typescript
import { Log } from '@jayobado/hono-kit'

Log.debug('cache warmed')
Log.info('server running')
Log.warn('slow response')
Log.error('connection failed')
await Log.flush()
```

logs/
├── debug_20260430.log
├── info_20260430.log
├── warn_20260430.log
└── error_20260430.log

On Cloudflare Workers, logs go to console only.

---

## Deployment

| Platform | Adapter | SPA strategy | Command |
|---|---|---|---|
| Local dev | `deno` | `lazy` + HMR | `deno task dev` |
| Deno Deploy | `deno` | `eager` | Push repo |
| VPS + Deno | `deno` | `eager` | `deno task start` |
| VPS + Node | `node` | `eager` or `build` | `node server.js` |
| Cloudflare Workers | `cloudflare` | `build` | `wrangler deploy` |
| Static (Pages/Vercel/Netlify) | n/a | `build` | `deno task build` |

### Deno Deploy

```typescript
const isDeploy = Deno.env.get('DENO_DEPLOYMENT_ID') !== undefined

await createServer({
  host: '0.0.0.0',
  port: parseInt(Deno.env.get('PORT') ?? '3000'),
  spa: { root: './client', strategy: isDeploy ? 'eager' : 'lazy', hmr: !isDeploy },
})
```

### Cloudflare Workers

```typescript
// worker.ts
import { createApp } from '@jayobado/hono-kit'

export default createApp({
  api: { routes: (app) => { ... } },
})
```

Pre-build SPA and deploy via Pages. Workers serves the API.

---

## Project structure

```
hono-kit/
├── mod.ts              # barrel export
├── types.ts            # all interfaces
├── server.ts           # createServer(), createApp()
├── middleware.ts        # requestId, errorHandler, accessLog, securityHeaders, compress
├── auth.ts             # createAuth, createMemoryStore, session middleware, encryption
├── spa.ts              # SPA serving — transpile, static files, HMR, fallback
├── transpile.ts        # transpiler abstraction, import rewriting, cache
├── events.ts           # EventBus — emit/subscribe, SSE streaming
├── ws.ts               # WebSocket — ConnectionManager, channels, auth upgrade
├── assets.ts           # static asset serving with cache headers
├── bundle.ts           # production build tool
├── logger.ts           # buffered daily rotating file logger
└── adapters/
├── deno.ts         # Deno.serve, file I/O, @deno/emit transpiler
├── node.ts         # @hono/node-server, fs, esbuild transpiler
└── cloudflare.ts   # Workers export adapter, no filesystem, esbuild transpiler
```

## License

MIT — Copyright 2026 Jeremy Obado