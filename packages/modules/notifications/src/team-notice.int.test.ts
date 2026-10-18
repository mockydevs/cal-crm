// What an automation's "Notify the team" step writes: team members of the business, once
// per visit, and never anyone outside the team.
import { randomUUID } from 'node:crypto';

import { withTenant } from '@repo/db';
import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { atAgency, place, suite, things, toldIn, type Place } from '../test/fixtures.js';
import { everyoneIn, notifyTeam, type TeamNotice } from './index.js';

const s = suite();

const automation = { id: randomUUID(), name: 'Welcome new leads' };
const notice = (to: TeamNotice['to'], more: Partial<TeamNotice> = {}): TeamNotice => ({
  to,
  message: 'A new lead came in: Jordan.',
  automation,
  visitKey: `automation:${randomUUID()}:tell:1`,
  ...more,
});
const tell = (at: Place, told: TeamNotice) =>
  withTenant(s.db, at.system, (trx) => notifyTeam(trx, at.system, told));

describe('telling the team', () => {
  it('tells everyone with a membership of the business, in the step’s words', async () => {
    const at = await place(s);
    const member = await at.join('member');
    const viewer = await at.join('viewer');
    // The agency's staff work in every business, and are not this business's team.
    const staff = await at.join({ agency: 'owner' });
    const { contactId } = await things(s, at);

    const told = await tell(at, notice('everyone', { recordId: contactId }));

    expect(told.sort()).toEqual([at.owner.id, member.id, viewer.id].sort());
    expect(told).not.toContain(staff.id);
    for (const row of await toldIn(s, at))
      expect(row).toMatchObject({
        kind: 'automation.notice',
        actor_kind: 'automation',
        actor_id: automation.id,
        subject_kind: 'automation',
        subject_id: automation.id,
        record_id: contactId,
        title: 'Welcome new leads',
        body: 'A new lead came in: Jordan.',
        collapse_key: null,
        event_id: null,
      });
    expect(
      (await withTenant(s.db, at.system, (trx) => everyoneIn(trx, at.businessId))).sort(),
    ).toEqual([at.owner.id, member.id, viewer.id].sort());
  });

  it('tells only the people named, and of them only those on the team', async () => {
    const at = await place(s);
    const member = await at.join('member');
    const staff = await at.join({ agency: 'member' });
    const elsewhere = await place(s);
    const stranger = await s.database.fixtures.user();
    const { contactId } = await things(s, at);

    const told = await tell(
      at,
      // A contact's id, someone in another business, someone in none: none of them is told.
      notice([member.id, staff.id, contactId, elsewhere.owner.id, stranger.id]),
    );

    expect(told.sort()).toEqual([member.id, staff.id].sort());
    expect(await toldIn(s, elsewhere)).toEqual([]);
  });

  it('tells each person once per visit to the step, and again on the next visit', async () => {
    const at = await place(s);
    const visit = notice('everyone');
    expect(await tell(at, visit)).toEqual([at.owner.id]);
    expect(await tell(at, visit)).toEqual([]);
    expect(await tell(at, notice('everyone'))).toEqual([at.owner.id]);
    expect(await toldIn(s, at)).toHaveLength(2);
  });

  it('respects a person who turned automations’ notices off', async () => {
    const at = await place(s);
    const member = await at.join('member');
    await s.database.withTenant(member.context, (sql) =>
      sql.query(
        `insert into notifications.preferences (business_id, user_id, kind, in_app)
         values ($1, $2, 'automation.notice', false)`,
        [at.businessId, member.id],
      ),
    );
    expect(await tell(at, notice('everyone'))).toEqual([at.owner.id]);
  });

  it('tells nobody when nobody is named, and needs a business to run in', async () => {
    const at = await place(s);
    expect(await tell(at, notice([]))).toEqual([]);
    const agency = atAgency(at);
    await expect(
      withTenant(s.db, agency, (trx) => notifyTeam(trx, agency, notice('everyone'))),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
