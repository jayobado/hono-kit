interface OrdersResponse {
  orders: { id: string; total: number; status: string }[]
  fetchedAt: number
}

export async function renderOrders(root: HTMLElement): Promise<void> {
  root.replaceChildren()

  const heading = document.createElement('h1')
  heading.textContent = 'Orders'

  const status = document.createElement('p')
  status.textContent = 'Loading…'

  const list = document.createElement('ul')

  const logout = document.createElement('button')
  logout.textContent = 'Sign out'
  logout.addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' })
    location.reload()
  })

  root.append(heading, status, list, logout)

  try {
    const res = await fetch('/api/orders')
    const data = await res.json() as OrdersResponse

    status.textContent = `Fetched ${data.orders.length} order(s) at ${new Date(data.fetchedAt).toLocaleTimeString()
      }`

    for (const order of data.orders) {
      const item = document.createElement('li')
      item.textContent = `${order.id} — $${order.total} (${order.status})`
      list.append(item)
    }
  } catch (err) {
    status.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}