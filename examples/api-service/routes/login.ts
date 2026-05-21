import { defineRoute, type Auth } from '@jayobado/hono-kit'
import { z } from 'zod'
import { USERS, type Session } from '../auth.ts'

const loginInput = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
})

export const loginRoute = (auth: Auth<Session>) =>
	defineRoute({
		method: 'POST',
		path: '/login',
		input: { body: loginInput },
		handler: async (c, { body }) => {
			const user = USERS[body.username]
			if (!user || user.password !== body.password) {
				return c.json({ message: 'Invalid credentials', code: 401 }, 401)
			}

			// auth.login calls toSession(this), sets the cookie, persists.
			await auth.login(c, {
				id: user.id,
				username: body.username,
				role: user.role,
			})

			return c.json({ ok: true, userId: user.id, role: user.role })
		},
	})