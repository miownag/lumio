// Bun.serve() dev server with HTML imports
import index from '../index.html'

Bun.serve({
  port: 3000,
  routes: {
    '/': index,
  },
  development: {
    hmr: true,
    console: true,
  },
})

console.log('Lumio Web running at http://localhost:3000')
