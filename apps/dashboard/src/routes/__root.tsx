import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

/** What every route can use: the query cache, which also holds who's signed in. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

// The app's pages are under _app, for people signed in; the sign-in pages are beside it.
export const Route = createRootRouteWithContext<RouterContext>()({ component: Outlet });
