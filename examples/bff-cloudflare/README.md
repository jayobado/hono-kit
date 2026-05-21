# Example: BFF on Cloudflare Workers

The same BFF shape as `bff-vps`, deployed to Cloudflare Workers. Demonstrates:

- KV-backed sessions (memory store doesn't work on Workers — they're stateless)
- Build-mode SPA serving (no `@deno/emit` at runtime on Workers)
- Reading env from `env.*` (no `Deno.env`)
- `export default { fetch }` instead of `serveDeno`

## Prerequisites

```bash
npm install -g wrangler
wrangler login
```

Create a KV namespace for sessions:

```bash
wrangler kv:namespace create SESSIONS
# Note the returned id, paste it into wrangler.toml
```

## Build and deploy

```bash
deno task build
wrangler deploy
```

## Files

- `wrangler.toml` — Cloudflare project config
- `src/worker.ts` — Worker entry (replaces `main.ts` from the Deno example)
- `src/auth.ts`, `src/routes.ts` — identical shape to the Deno BFF
- `scripts/build.ts` — produces `dist/` with the manifest

## Why no dev mode?

Workers don't have a filesystem at runtime; `@deno/emit` can't run there.
For local development of a CF Worker, run `wrangler dev` against a built
`dist/`. For live SPA development, run `bff-vps` locally with `MODE=dev`,
then `wrangler deploy` when ready.