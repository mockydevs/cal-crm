// The API, on the same site: the server serves the dashboard, and in development Vite
// passes /api on to the server. The session cookie goes with every request.
import { createClient, type Client } from '@repo/sdk';

const baseUrl = '/api/v1';

/** The API outside any business: at the agency, for its staff. */
export const api = createClient({ baseUrl });

/**
 * The API in one business: every request names it with the Business-Id header. A page sends
 * what it shows to the business in its own address, whichever business other tabs are in.
 */
export function apiIn(businessId: string): Client {
  return createClient({ baseUrl, business: () => businessId });
}
