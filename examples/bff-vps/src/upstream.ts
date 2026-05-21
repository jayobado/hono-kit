import { createUpstream } from '@jayobado/hono-kit'
import { auth } from './auth.ts'

const baseUrl = Deno.env.get('UPSTREAM_BASE_URL') ?? 'http://localhost:3000'

export const upstream = createUpstream({
	baseUrl,
	credentialFrom: (c) => auth.backendHeaders(c),
	defaultHeaders: { 'X-Service': 'bff-vps' },
	requestIdHeader: 'X-Request-Id',
	timeout: 10_000,
})