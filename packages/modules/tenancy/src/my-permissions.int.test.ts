import { builtInPermissions, permissionCatalog, permissions } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { myPermissionsOf } from './my-permissions.js';

const agencyId = '0199c7e2-0000-7000-8000-000000000001';
const businessId = '0199c7e2-0000-7000-8000-000000000002';
const context = {
  agencyId,
  actorKind: 'user',
  actorId: agencyId,
  correlationId: 'b1-15',
} as const;

describe('what the caller may change', () => {
  it('is exactly the grants of the request, in the order of the catalog', () => {
    const answer = myPermissionsOf({
      context: { ...context, businessId },
      permissions: new Set(['views.save', 'contacts.manage']),
    });
    expect(answer).toEqual({
      business: toPublicId('business', businessId),
      permissions: ['contacts.manage', 'views.save'],
    });
  });

  it('is nothing for a role that gives nothing, and names no business at the agency', () => {
    expect(myPermissionsOf({ context, permissions: new Set() })).toEqual({
      business: null,
      permissions: [],
    });
    // A viewer changes nothing, and may ask the assistant.
    expect(
      myPermissionsOf({ context, permissions: new Set(builtInPermissions.business['viewer']) }),
    ).toEqual({ business: null, permissions: ['assistant.use'] });
  });

  it('is everything that applies in the place, for a caller that may do everything', () => {
    const inBusiness = myPermissionsOf({ context: { ...context, businessId }, permissions: 'all' });
    const atAgency = myPermissionsOf({ context, permissions: 'all' });
    expect(inBusiness.permissions).toEqual(
      permissions.filter((key) => permissionCatalog[key].scope !== 'agency'),
    );
    expect(atAgency.permissions).toEqual(
      permissions.filter((key) => permissionCatalog[key].scope !== 'business'),
    );
    expect(inBusiness.permissions).not.toContain('businesses.create');
    expect(atAgency.permissions).toContain('businesses.create');
  });
});
