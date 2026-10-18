// What the caller may change where the request works, so a screen can hide what the person
// cannot do before it asks for anything. It reads no table: the request's grants were
// worked out when it signed in, and every command still checks its own permission whatever
// this answers.
import type { Invocation, Route } from '@repo/commands';
import {
  getMyPermissions,
  permissionCatalog,
  permissions,
  type MyPermissions,
} from '@repo/contracts';
import { toPublicId } from '@repo/kernel';

/** The invocation's grants as a list, in the catalog's order. */
export function myPermissionsOf({ context, permissions: grants }: Invocation): MyPermissions {
  const place = context.businessId === undefined ? 'agency' : 'business';
  return {
    business: context.businessId === undefined ? null : toPublicId('business', context.businessId),
    permissions: permissions.filter((key) =>
      grants === 'all'
        ? // The system's "everything" is everything that applies in this place.
          permissionCatalog[key].scope === place || permissionCatalog[key].scope === 'both'
        : grants.has(key),
    ),
  };
}

export const getMyPermissionsRoute = {
  endpoint: getMyPermissions,
  run: ({ invocation }) => Promise.resolve(myPermissionsOf(invocation)),
} satisfies Route<typeof getMyPermissions>;
