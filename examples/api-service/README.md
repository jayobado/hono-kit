# Example: API service

A standalone API service using `createApiApp`. Demonstrates:

- Auth + sessions with `createAuth` and `createMemoryStore`
- Typed routes with `defineRoute` and Zod validation
- The services pattern (business logic decoupled from HTTP)
- `/health` and `/ready` endpoints

This service is the thing a BFF (or any other client) would talk to.
It does its own auth — clients log in here and use cookies on subsequent calls.

## Run

```bash
deno task dev
```

Then in another terminal:

```bash
# Login
curl -c cookies.txt -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"hunter2"}'

# Authenticated request
curl -b cookies.txt http://localhost:3000/orders

# Create an order (admin role required)
curl -b cookies.txt -X POST http://localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"items":[{"sku":"a","qty":2}],"total":50}'

# Health
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## Files

- `main.ts` — app composition + serve
- `services/orders.ts` — business logic, no HTTP
- `routes/orders.ts` — thin HTTP layer
- `routes/login.ts` — login route
- `auth.ts` — login + auth configuration