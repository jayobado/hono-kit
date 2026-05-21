# Examples

Three working starter projects covering the deployment shapes hono-kit is
designed for. Each is self-contained — copy the directory, adapt to your
needs.

| Example | Description | Runtime |
|---|---|---|
| [`api-service`](./api-service) | Standalone API service with `createApiApp`, auth, and the services pattern | Deno |
| [`bff-vps`](./bff-vps) | BFF wrapping an SPA, talking to an upstream API | Deno on VPS |
| [`bff-cloudflare`](./bff-cloudflare) | Same BFF shape, deployed to Workers | Cloudflare |

## Choosing an example

- **Building an internal API?** Start with `api-service`.
- **Building a single SPA + BFF for a VPS or container?** Start with `bff-vps`.
- **Deploying to Cloudflare?** Start with `bff-cloudflare`.

The BFF examples pair with `api-service` as the upstream. Run all three
together to see the full request flow:

```bash
# Terminal 1
cd examples/api-service && deno task dev

# Terminal 2
cd examples/bff-vps && deno task dev

# Browser → http://localhost:3001
```

## What each example does NOT cover

- **WebSockets** — see `docs/recipes/` once you need them
- **ConnectRPC / tRPC / GraphQL clients** — see `docs/recipes/`
- **Multi-portal cookie scoping** — see `docs/recipes/multi-portal.md`
- **Real databases** — the examples use `Map` for clarity. Swap for `pg`,
  `@jayobado/go-pgkit` (with a TS wrapper), or your DB of choice.
- **Production secrets management** — examples use plain env vars. In
  production use Deno KV secrets, CF Worker secrets (`wrangler secret`), or
  a vault.

## Repo layout

```
examples/
├── README.md                ← this file
├── api-service/
│   ├── README.md
│   ├── deno.json
│   ├── main.ts
│   ├── auth.ts
│   ├── services/orders.ts
│   └── routes/
│       ├── auth.ts
│       └── orders.ts
├── bff-vps/
│   ├── README.md
│   ├── deno.json
│   ├── src/
│   │   ├── main.ts
│   │   ├── auth.ts
│   │   ├── upstream.ts
│   │   └── routes/orders.ts
│   ├── client/
│   │   ├── index.html
│   │   ├── main.ts
│   │   ├── style.css
│   │   └── components/
│   │       ├── login.ts
│   │       └── orders.ts
│   └── scripts/build.ts
└── bff-cloudflare/
    ├── README.md
    ├── wrangler.toml
    ├── deno.json
    ├── src/worker.ts
    └── scripts/build.ts
```