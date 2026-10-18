// A page that takes the whole window: the workflow builder has no sidebar and no top bar
// around it. A route says so in its static data, from its own address, so the shell knows
// before the page has loaded and nothing flashes.
import { useRouterState } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Whether the page at this address, with this search, uses the whole window. */
    readonly fullWindow?: (search: Readonly<Record<string, unknown>>) => boolean;
  }
}

/** Whether the page on screen asked for the whole window. */
export function useFullWindow(): boolean {
  return useRouterState({
    select: (state) =>
      state.matches.some((match) => {
        const search: Readonly<Record<string, unknown>> = { ...match.search };
        return match.staticData.fullWindow?.(search) === true;
      }),
  });
}
