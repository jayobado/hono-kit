import { createAuth, createMemoryStore } from '@jayobado/hono-kit'

// The session stores the user's identity + the upstream API service's
// session cookie. We need the upstream cookie to forward auth on subsequent
// calls. (In a real OAuth setup this would be an access_token instead.)
export interface Session {
	userId: string
	role: 'admin' | 'user'
	upstreamCookie: string
}

export const auth = createAuth<Session>({
	store: createMemoryStore<Session>(),
	cookie: {
		name: 'bff_sid',
		secure: false, // set true behind TLS
		sameSite: 'Lax',
	},
	toSession: (r: any) => ({
		userId: r.userId,
		role: r.role,
		upstreamCookie: r.upstreamCookie ?? '',
	}),
	credential: {
		field: 'upstreamCookie',
		header: 'Cookie',
		format: (v) => v, // pass the cookie value as-is
	},
})