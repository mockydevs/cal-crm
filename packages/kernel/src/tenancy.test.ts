import { describe, expect, it } from 'vitest';

import { tenantSettings } from './index.js';

const agency = '01890a5d-ac96-774b-bcce-b302099a8057';
const business = '01890a5d-ac96-774b-bcce-b302099a8058';
const user = '01890a5d-ac96-774b-bcce-b302099a8059';
const correlation = '01890a5d-ac96-774b-bcce-b302099a805a';

// The settings and their order are the ones in packages/db/README.md, "The request context".
describe('tenantSettings', () => {
  it('gives the app.* settings that start every transaction', () => {
    expect(
      tenantSettings({
        agencyId: agency,
        businessId: business,
        userId: user,
        actorKind: 'user',
        actorId: user,
        correlationId: correlation,
      }),
    ).toEqual([
      ['app.agency_id', agency],
      ['app.business_id', business],
      ['app.user_id', user],
      ['app.actor_kind', 'user'],
      ['app.actor_id', user],
      ['app.correlation_id', correlation],
    ]);
  });

  it('leaves out the business for agency staff, and the user and actor when there are none', () => {
    expect(
      tenantSettings({ agencyId: agency, actorKind: 'system', correlationId: correlation }),
    ).toEqual([
      ['app.agency_id', agency],
      ['app.business_id', ''],
      ['app.user_id', ''],
      ['app.actor_kind', 'system'],
      ['app.actor_id', ''],
      ['app.correlation_id', correlation],
    ]);
  });
});
