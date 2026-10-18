// Where the signed-in person works: their agency, and the businesses they may enter, from
// GET /api/v1/me. A business's pages are under /b/{its slug}, and the agency's under
// /agency.
import { getMe, type BusinessSummary } from '@repo/contracts';
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useMatch } from '@tanstack/react-router';
import { api } from './api';

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => api.request(getMe, {}),
  staleTime: 60_000,
});

const businessRoute = getRouteApi('/_app/b/$slug');

/** The business a page is in: the one its address names, which the person may enter. */
export function useBusiness(): BusinessSummary {
  return businessRoute.useRouteContext({ select: (context) => context.business });
}

/**
 * For the shell, which is around every page: the business the address names, if the
 * person may enter it. None at the agency, on a page outside any business, or for a slug
 * that the not-found page answers.
 */
export function useBusinessInAddress(): BusinessSummary | undefined {
  const { businesses } = useSuspenseQuery(meQuery).data;
  const slug = useMatch({
    from: '/_app/b/$slug',
    shouldThrow: false,
    select: (match) => match.params.slug,
  });
  return businesses.find((candidate) => candidate.slug === slug);
}

/** Up to two initials for an avatar: from a name, or else the fallback's first letter. */
export function initialsOf(name: string, fallback: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const letters = words.length > 0 ? words.slice(0, 2).map((word) => word[0]) : [fallback[0]];
  return letters.join('').toUpperCase();
}
