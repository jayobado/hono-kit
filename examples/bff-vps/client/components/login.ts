export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
	root.replaceChildren()

	const form = document.createElement('form')
	const heading = document.createElement('h1')
	heading.textContent = 'Sign in'

	const username = document.createElement('input')
	username.name = 'username'
	username.placeholder = 'username'
	username.required = true

	const password = document.createElement('input')
	password.name = 'password'
	password.type = 'password'
	password.placeholder = 'password'
	password.required = true

	const submit = document.createElement('button')
	submit.type = 'submit'
	submit.textContent = 'Sign in'

	const error = document.createElement('p')
	error.className = 'error'

	form.append(heading, username, password, submit, error)
	root.append(form)

	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		error.textContent = ''

		const res = await fetch('/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				username: username.value,
				password: password.value,
			}),
		})

		if (res.ok) {
			onSuccess()
		} else {
			error.textContent = 'Invalid credentials'
		}
	})
}