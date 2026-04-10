import { Hono } from 'hono'

export const app = new Hono()

// TODO: Mount middleware (auth, cors, rate-limit)
// TODO: Mount routes (auth, sessions, messages, sandboxes, sync)

app.get('/health', (c) => c.json({ status: 'ok' }))
