# Example: BFF on a VPS

A BFF wrapping a lolo-ui-style SPA, talking to an upstream API. Demonstrates:

- `createBff` composing auth, API, and SPA in one process
- Mode switching: `dev` (HMR) → `transpile` (no build) → `build` (production)
- Cookie-only auth (tokens never reach the browser)
- Upstream forwarding via `createUpstream`
- Graceful shutdown via `onShutdown`

This shape pairs with the `api-service` example. Run that one on port 3000,
this BFF on port 3001, and the SPA talks to the BFF, which talks to the API.

> The example uses vanilla TypeScript for the SPA, not a UI framework. The
> point is the BFF shape, not the frontend stack. In your real app, replace
> the `client/` contents with lolo-ui, React, Solid, or whatever you use —
> the BFF doesn't care.

## Layout

```
bff-vps/
├── client/             ← the SPA source (TS, HTML, CSS)
│   ├── index.html
│   ├── main.ts
│   └── components/
├── src/
│   ├── main.ts         ← BFF entry
│   ├── auth.ts
│   ├── upstream.ts
│   └── routes/
│       └── orders.ts
└── deno.json
```

## Run

```bash
# Dev mode (default): HMR, lazy transpile
deno task dev

# Transpile mode: eager warm, no HMR — for VPS prod without a build step
MODE=transpile deno task start

# Build mode: pre-built static files
deno task build
MODE=build deno task start
```

Then visit http://localhost:3001. Logging in calls the upstream API service
(must be running on port 3000); subsequent requests carry the credential
from the BFF's session.

## How modes work

The same code switches between three serving strategies based on `MODE`:

- `dev` — lazy transpile + HMR (Deno only). Default for `deno task dev`.
- `transpile` — eager warm + pre-gzip, no HMR (Deno only). Ships TS source.
- `build` — pre-bundled static files (works anywhere). Requires `deno task build`.

For Cloudflare deployment, see `examples/bff-cloudflare`.