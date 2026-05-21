import { createAuth, createMemoryStore } from '@jayobado/hono-kit'

export interface Session {
	userId: string
	username: string
	role: 'admin' | 'user'
}

// Demo users — in a real app, look up from your user store.
export const USERS: Record<string, { id: string; password: string; role: Session['role'] }> = {
	alice: { id: 'u_alice', password: 'hunter2', role: 'admin' },
	bob: { id: 'u_bob', password: 'pa55word', role: 'user' },
}

export const auth = createAuth<Session>({
	store: createMemoryStore<Session>(),
	cookie: {
		name: 'sid',
		secure: false, // set true behind TLS in prod
		sameSite: 'Lax',
		maxAge: 60 * 60 * 24 * 7, // 1 week
	},
	toSession: (r: any) => ({
		userId: r.id,
		username: r.username,
		role: r.role,
	}),
})