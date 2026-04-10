import { app } from './app'

Bun.serve({
  port: 3001,
  fetch: app.fetch,
})

console.log('Lumio Server running at http://localhost:3001')
