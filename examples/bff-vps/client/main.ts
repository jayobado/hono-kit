// Minimal vanilla SPA. The example is about the BFF, not the frontend.
// In your real app, replace this with lolo-ui, React, Solid, or whatever.

import { renderLogin } from './components/login.ts'
import { renderOrders } from './components/orders.ts'

async function isAuthenticated(): Promise<boolean> {
	const res = await fetch('/api/orders')
	return res.status !== 401
}

async function render() {
	const root = document.getElementById('app')
	if (!root) return

	if (await isAuthenticated()) {
		renderOrders(root)
	} else {
		renderLogin(root, () => render())
	}
}

render()