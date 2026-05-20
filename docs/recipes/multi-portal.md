# Multi-portal deployment

Run admin and user portals as separate BFF processes sharing the same
upstream services. Different cookies, different ports, but one stack.

## Shape

```
                  ┌─────────────────────┐
                  │      nginx          │
                  │  (TLS + routing)    │
                  └──────┬──────┬───────┘
            admin.tld    │      │   app.tld
                         ▼      ▼
              ┌──────────────┐  ┌──────────────┐
              │  admin-bff   │  │   user-bff   │
              │  (port 3001) │  │  (port 3002) │
              └──────┬───────┘  └──────┬───────┘
                     │                  │
                     └────────┬─────────┘
                              ▼
                     ┌────────────────┐
                     │   upstream     │
                     │   services     │
                     └────────────────┘
```

Two processes, one VPS (or one wrangler project per portal on Cloudflare).
They share **nothing at runtime** — different cookies, different
session stores, different upstream credentials.

## Cookie isolation

The key thing to get right is cookie scoping. Use **different cookie
names** for each portal:

```ts
// admin-bff/src/main.ts
const auth = createAuth({
  cookie: {
    name: 'admin_sid',            // unique per portal
    domain: '.example.com',        // both subdomains can see it...
    secure: true,
    sameSite: 'Lax',
  },
  // ...
})

// user-bff/src/main.ts
const auth = createAuth({
  cookie: {
    name: 'user_sid',              // ...but the names don't collide
    domain: '.example.com',
    secure: true,
    sameSite: 'Lax',
  },
  // ...
})
```

If you don't need cross-subdomain cookies (e.g. admin.example.com and
app.example.com don't share auth state), omit `domain` and the cookie
will only be sent to the originating subdomain. This is the safer default.

## Shared code

Most BFF code is identical between portals. Extract the common pieces:

```ts
// shared/upstream.ts
import { createUpstream } from '@jayobado/hono-kit'

export function buildUpstream(auth: Auth<Session>) {
  return createUpstream({
    baseUrl: Deno.env.get('UPSTREAM_BASE_URL')!,
    credentialFrom: (c) => auth.backendHeaders(c),
    requestIdHeader: 'X-Request-Id',
  })
}

// shared/routes/profile.ts
export const profileRoutes = (auth: Auth<Session>, upstream: Upstream) =>
  defineRoutes([
    defineRoute({
      method: 'GET',
      path: '/me',
      guards: [auth.require()],
      handler: (c) => c.json(auth.getSession(c)),
    }),
  ])
```

Then per-portal:

```ts
// admin-bff/src/main.ts
import { profileRoutes } from '../shared/routes/profile.ts'
import { adminRoutes } from './routes/admin.ts'

const auth = createAuth({ cookie: { name: 'admin_sid', /*...*/ } })
const upstream = buildUpstream(auth)

const bff = createBff({
  auth,
  api: defineRoutes([
    ...profileRoutes(auth, upstream),
    ...adminRoutes(auth, upstream),
  ]),
  spa: serveAssets({ root: './admin-dist' }),
})

await serveDeno(bff, { port: 3001 })
```

## nginx config

```nginx
server {
  server_name admin.example.com;
  listen 443 ssl;
  # ...tls config

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # WebSocket upgrade
  location /ws {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}

server {
  server_name app.example.com;
  listen 443 ssl;

  location / {
    proxy_pass http://127.0.0.1:3002;
    # ...same headers
  }
}
```

## systemd units

`admin-bff.service`:

```ini
[Unit]
Description=Admin BFF
After=network.target

[Service]
Type=simple
User=www
WorkingDirectory=/srv/admin-bff
EnvironmentFile=/etc/admin-bff.env
ExecStart=/usr/local/bin/deno run -A src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Mirror for `user-bff.service` with its own `EnvironmentFile`.

## Notes

- **Session bleed.** If both portals use cookie name `sid` and overlapping
  domains, they'll trample each other. Always use distinct names.
- **CORS.** If the BFF and SPA are on the same domain (which they should
  be — the whole point of a BFF is that the SPA is the BFF), you don't need
  CORS. If you ever find yourself enabling CORS on a BFF, ask why first.
- **Sharing upstream credentials.** Each portal's user has their own
  upstream token (from `auth.toSession`). The BFFs never share credentials
  between sessions — every outbound call carries the calling user's token.
- **Logging.** Use distinct `defaultHeaders: { 'X-Service': 'admin-bff' }`
  on each portal's upstream so logs upstream can distinguish callers.