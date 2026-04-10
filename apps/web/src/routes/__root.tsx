import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router'
import React from 'react'

// Root layout
const rootRoute = createRootRoute({
  component: () => (
    <div>
      <Outlet />
    </div>
  ),
})

// / — Session list (dashboard)
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <div>TODO: Session List</div>,
})

// /login
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => <div>TODO: Login</div>,
})

// /chat/$id
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat/$id',
  component: () => <div>TODO: Chat</div>,
})

// /chat/$id/sandbox
const sandboxRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '/sandbox',
  component: () => <div>TODO: Sandbox</div>,
})

// /settings
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: () => <div>TODO: Settings</div>,
})

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  chatRoute.addChildren([sandboxRoute]),
  settingsRoute,
])
