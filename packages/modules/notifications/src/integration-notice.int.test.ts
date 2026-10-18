// An integration that needs someone: who manages the business's integrations is told, and
// the notification opens Settings → Integrations, which has no id of its own.
import { randomUUID } from 'node:crypto';

import { notificationList } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { describe, expect, it } from 'vitest';

import { place, suite } from '../test/fixtures.js';
import { createNotificationRoutes, deliver, membersHolding } from './index.js';

const s = suite();
const routes = createNotificationRoutes({ actorNames: { user: () => Promise.resolve(new Map()) } });

describe('an integration that needs attention', () => {
  it('tells those who may manage integrations, and opens Settings → Integrations', async () => {
    const at = await place(s);
    const admin = await at.join('admin');
    const member = await at.join('member');
    const told = await withTenant(s.db, at.system, async (trx) => {
      const managers = await membersHolding(trx, at.system, ['integrations.manage']);
      return deliver(trx, at.system, {
        kind: 'integration.needs_attention',
        recipients: [member.id, ...managers],
        sourceKey: `integration.needs_attention:${randomUUID()}`,
        collapseKey: `integration.needs_attention:${randomUUID()}`,
        cause: { kind: 'system', id: null },
        subject: { kind: 'integrations' },
        title: 'Stand-in',
      });
    });
    // The member who connected it is told too, as the worker names them.
    expect(told.sort()).toEqual([at.owner.id, admin.id, member.id].sort());
    const list = routes.find((each) => each.endpoint.operationId === 'listNotifications');
    const answer = notificationList.parse(
      await list?.run(
        { invocation: admin.invocation, params: {}, query: {}, body: undefined },
        { db: s.db, authorize: () => true },
      ),
    );
    expect(answer.items[0]).toMatchObject({
      kind: 'integration.needs_attention',
      target: { kind: 'integrations' },
      title: 'Stand-in',
    });
  });
});
