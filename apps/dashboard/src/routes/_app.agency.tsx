import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../workspace';

// The agency's own pages, for its staff. Anyone else works only in their businesses, so
// they go back to where the app opens.
export const Route = createFileRoute('/_app/agency')({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.query(meQuery)).agencyStaff) {
      throw redirect({ to: '/', replace: true });
    }
  },
});
