# Deploying to Cloudflare Workers

Cloudflare Workers run hono-kit BFFs with two constraints:

1. Sessions can't use the in-process memory store (Workers are stateless).
   Use **KV** or **Durable Objects** instead.
2. SPA dev mode and transpile mode don't work (no filesystem, no
   `@deno/emit` at runtime). Build with `bundle.ts` and serve with
   `serveAssets`.

## wrangler.toml

```toml
name = "admin-bff"
main = "src/worker.ts"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "SESSIONS"
id = "xxxxxxxxxxxxxxxx"

[site]
bucket = "./dist"
```

## worker.ts

```ts
import {
  createAuth,
  defineRoute, defineRoutes,
  createUpstream,
  createBff,
  serveAssets,
} from '@jayobado/hono-kit'
import { createKvSessionStore } from '@jayobado/hono-kit/cf-stores'
import { getAssetFromKV } from '@cloudflare/kv-asset-handler'

type Env = {
  SESSIONS: KVNamespace
  __STATIC_CONTENT: KVNamespace
  UPSTREAM_BASE_URL: string
  SESSION_COOKIE_DOMAIN: string
}

type Session = {
  userId: string
  role: 'admin' | 'user'
  upstreamToken: string
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const auth = createAuth<Session>({
      store: createKvSessionStore(env.SESSIONS),
      cookie: {
        name: 'admin_sid',
        domain: env.SESSION_COOKIE_DOMAIN,
        secure: true,
      },
      toSession: (r: any) => ({
        userId: r.user.id,
        role: r.user.role,
        upstreamToken: r.access_token,
      }),
      credential: { field: 'upstreamToken' },
    })

    const upstream = createUpstream({
      baseUrl: env.UPSTREAM_BASE_URL,
      credentialFrom: (c) => auth.backendHeaders(c),
    })

    const api = defineRoutes([
      defineRoute({
        method: 'GET',
        path: '/orders',
        guards: [auth.require()],
        handler: async (c) =>
          c.json(await upstream.get(c, '/orders')),
      }),
    ])

    // Serve from Workers Sites
    const spa = serveAssets({
      root: '.',
      readBinary: async (path) => {
        const evt = { request: new Request(`https://placeholder${path}`) } as any
        const res = await getAssetFromKV(evt, {
          ASSET_NAMESPACE: env.__STATIC_CONTENT,
          mapRequestToAsset: r => r,
        })
        return new Uint8Array(await res.arrayBuffer())
      },
    })

    const bff = createBff({ auth, api, spa })
    return bff.fetch(req, env, ctx)
  },
}
```

## Choosing KV vs Durable Object sessions

**Use KV (`createKvSessionStore`) when:**
- Sessions are read-mostly
- Eventual consistency is OK (a 60-second stale window won't break you)
- You want global distribution for free

**Use Durable Objects (`createDurableObjectSessionStore`) when:**
- Sessions are updated frequently (e.g. activity timestamps, rate limit counters)
- You need strict read-after-write consistency
- Active sessions per region — DO gives you a coordinated single point

Most BFFs are fine with KV. Switch to DO if you hit consistency issues.

## Building the SPA for Workers

```bash
deno run -A scripts/build.ts
wrangler deploy
```

`scripts/build.ts`:

```ts
import { build } from '@jayobado/hono-kit'

await build({
  entry: './client/main.tsx',
  outDir: './dist',
  importMap: './deno.json',
  minify: true,
})
```

The output (`dist/`) is what `[site].bucket` in wrangler.toml points to.
`wrangler deploy` uploads `dist/` to `__STATIC_CONTENT` KV automatically.

## Notes

- **No SIGINT/SIGTERM.** Workers don't have lifecycle hooks; `onShutdown`
  is a no-op there. Cleanup happens automatically when the worker is evicted.
- **`Deno.env` doesn't work.** Use `env.VAR` from the `fetch` handler argument.
- **CPU limits.** Workers free tier gives you 10ms CPU per request, paid gives
  you 30s. The transpile mode would blow this — build statically.
- **WebSocket:** supported via Durable Objects. Use a DO as your WebSocket
  fan-out target rather than `createChannels` (which is in-process).