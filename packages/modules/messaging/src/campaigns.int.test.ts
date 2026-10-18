// Email campaigns against real Postgres, with the mail server replaced by a stand-in that
// keeps what it is handed: who gets a campaign and who does not and why, that nobody gets
// it twice whatever is retried, paused or resumed, and that the limits hold.
import { randomUUID } from 'node:crypto';

import { runCommand } from '@repo/commands';
import {
  emailCampaign,
  emailCampaignAudiencePreview,
  emailCampaignChecks,
  emailCampaignFolderList,
  emailCampaignList,
  emailCampaignRecipientList,
  emailCampaignSettings,
  emailCampaignStats,
  permissions,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { campaignWorld, PUBLIC_URL } from '../test/campaigns.js';
import { readAudiencePreview } from './campaign-audience.js';
import { readCampaignChecks } from './campaign-checks.js';
import { readCampaignRecipients, readCampaignStats } from './campaign-results.js';
import { scheduleEmailCampaigns } from './campaign-run.js';
import { audienceOf, requireCampaign } from './campaign-store.js';
import { TEST_UNSUBSCRIBE_NOTE } from './campaign-tests.js';
import { readCampaign, readCampaigns, readCampaignSettings } from './campaigns.js';
import { queueOutboundMessage, readOutboundPolicy } from './outbound.js';
import {
  createCampaignFolderCommands,
  readCampaignFolders,
  readTemplateFolders,
} from './template-folders.js';
import { unsubscribeFromLink } from './unsubscribe.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const world = (setup?: Parameters<typeof campaignWorld>[3]) =>
  campaignWorld(database, db, vault, setup);
const everythingBut = (...denied: Permission[]): readonly Permission[] =>
  permissions.filter((each) => !denied.includes(each));
const listQuery = { limit: 50 };

describe('drafts', () => {
  it('starts blank, from a template or as a copy, and saves only at the revision it was read', async () => {
    const w = await world();
    const blank = await runCommand(w.services, w.commands.create, { name: 'Blank' }, w.as());
    expect(emailCampaign.parse(blank)).toMatchObject({
      status: 'draft',
      subject: '',
      content: { format: 'text', text: '' },
      audience: null,
      schedule: null,
      revision: 1,
      canManage: true,
      canSend: true,
    });

    const template = await w.inTenant((trx) =>
      trx
        .insertInto('messaging.templates')
        .values({
          business_id: w.business.id,
          name: 'Welcome',
          subject: 'Welcome {{contact.firstName}}',
          body: 'Hello there',
          created_by_kind: 'user',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const fromTemplate = await runCommand(
      w.services,
      w.commands.create,
      {
        name: 'From template',
        source: { kind: 'template', templateId: toPublicId('template', template.id) },
      },
      w.as(),
    );
    expect(fromTemplate).toMatchObject({
      subject: 'Welcome {{contact.firstName}}',
      content: { format: 'text', text: 'Hello there' },
      templateId: toPublicId('template', template.id),
      mergeFields: ['contact.firstName'],
    });
    await expect(
      runCommand(
        w.services,
        w.commands.create,
        {
          name: 'No such',
          source: { kind: 'template', templateId: toPublicId('template', randomUUIDv7()) },
        },
        w.as(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const full = await w.draft({
      fromName: 'Dana',
      replyTo: 'dana@example.test',
      preheader: 'Doors open at ten',
      content: { format: 'html', html: '<p>Hi {{contact.firstName}}</p>', text: 'Hi' },
    });
    expect(full.revision).toBe(2);
    const copy = await runCommand(
      w.services,
      w.commands.create,
      { name: 'Copy', source: { kind: 'campaign', campaignId: full.id } },
      w.as(),
    );
    expect(copy).toMatchObject({
      name: 'Copy',
      status: 'draft',
      fromName: 'Dana',
      replyTo: 'dana@example.test',
      preheader: 'Doors open at ten',
      format: 'html',
      audience: w.tagAudience,
      mailboxId: full.mailboxId,
    });

    // A save at a stale revision changes nothing.
    await expect(w.draft({}, w.as()).then((d) => staleSave(w, d))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      w.draft({ folderId: toPublicId('email_campaign_folder', randomUUIDv7()) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      w.draft({ mailboxId: toPublicId('mailbox', randomUUIDv7()) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('lists by name, status and folder, a page at a time, and moves and deletes', async () => {
    const w = await world();
    const folders = createCampaignFolderCommands();
    const folder = await runCommand(w.services, folders.create, { name: 'Spring' }, w.as());
    const inner = await runCommand(
      w.services,
      folders.create,
      { name: 'Open days', parentId: folder.id },
      w.as(),
    );
    const first = await w.draft({ name: 'Alpha launch' });
    const second = await w.draft({ name: 'Beta news', folderId: inner.id });
    const third = await w.draft({ name: 'Gamma news' });

    const read = (query: object) =>
      w.inTenant((trx) => readCampaigns(trx, w.as(), { ...listQuery, ...query }));
    const all = emailCampaignList.parse(await read({}));
    expect(all.items.map((item) => item.name)).toEqual(['Gamma news', 'Beta news', 'Alpha launch']);
    expect(all.total).toBe(3);
    expect(await read({ q: 'NEWS' })).toMatchObject({ items: { length: 2 }, total: 2 });
    expect((await read({ status: 'sent' })).total).toBe(0);
    expect((await read({ folder: 'root', limit: 1 })).total).toBe(2);
    expect((await read({ status: 'sent' })).items).toHaveLength(0);
    expect((await read({ folder: 'root' })).items.map((item) => item.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect((await read({ folder: inner.id })).items.map((item) => item.id)).toEqual([second.id]);
    const page = await read({ limit: 2 });
    expect(page.next).toBe(second.id);
    // Counted before the page's place: the same on every page.
    expect(page.total).toBe(3);
    expect((await read({ limit: 2, after: page.next })).total).toBe(3);
    expect((await read({ limit: 2, after: page.next })).items.map((item) => item.id)).toEqual([
      first.id,
    ]);

    // Folders of campaigns are a tree of their own: the template library does not show them.
    const tree = emailCampaignFolderList.parse(
      await w.inTenant((trx) => readCampaignFolders(trx, w.as())),
    );
    expect(tree.items.map((item) => [item.name, item.campaignCount])).toEqual([
      ['Open days', 1],
      ['Spring', 0],
    ]);
    expect(tree.counts).toEqual({ all: 3, unfiled: 2 });
    expect((await w.inTenant((trx) => readTemplateFolders(trx, w.as()))).items).toEqual([]);

    const moved = await runCommand(
      w.services,
      w.commands.move,
      { id: first.id, folderId: folder.id },
      w.as(),
    );
    expect(moved.folderId).toBe(folder.id);
    const renamed = await runCommand(
      w.services,
      folders.update,
      { id: inner.id, revision: inner.revision, name: 'Tours', parentId: null },
      w.as(),
    );
    expect(renamed).toMatchObject({ name: 'Tours', parentId: null, campaignCount: 1 });
    await expect(
      runCommand(w.services, folders.create, { name: ' tours ' }, w.as()),
    ).rejects.toBeInstanceOf(ConflictError);
    // Removing a folder moves what it held to its parent and deletes no campaign.
    await runCommand(
      w.services,
      folders.remove,
      { id: folder.id, revision: folder.revision },
      w.as(),
    );
    expect((await w.inTenant((trx) => readCampaign(trx, w.as(), first.id))).folderId).toBeNull();
    await expect(
      runCommand(w.services, folders.remove, { id: folder.id, revision: 1 }, w.as()),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      runCommand(w.services, w.commands.remove, { id: third.id, revision: 1 }, w.as()),
    ).rejects.toBeInstanceOf(ConflictError);
    await runCommand(
      w.services,
      w.commands.remove,
      { id: third.id, revision: third.revision },
      w.as(),
    );
    await expect(w.inTenant((trx) => readCampaign(trx, w.as(), third.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      w.inTenant((trx) => readCampaign(trx, w.as(), 'camp_nonsense')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps the business's ceiling where the mailbox limits are kept", async () => {
    const w = await world({ agencyDailyLimit: 5000 });
    const before = await w.inTenant((trx) => readCampaignSettings(trx, w.as(), w.options));
    expect(emailCampaignSettings.parse(before)).toMatchObject({
      dailyLimit: null,
      agencyDailyLimit: 5000,
      bounceRatePause: { percent: 5, afterSent: 100 },
      canManage: true,
    });
    const saved = await runCommand(w.services, w.commands.settings, { dailyLimit: 250 }, w.as());
    expect(saved.dailyLimit).toBe(250);
    await expect(
      runCommand(
        w.services,
        w.commands.settings,
        { dailyLimit: 10 },
        w.as(everythingBut('mailboxes.manage')),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      (
        await w.inTenant((trx) =>
          readCampaignSettings(trx, w.as(everythingBut('mailboxes.manage')), w.options),
        )
      ).canManage,
    ).toBe(false);
  });
});

/** Any UUIDv7, for an id that names nothing. */
function randomUUIDv7(): string {
  const hex = randomUUID().replaceAll('-', '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function staleSave(
  w: Awaited<ReturnType<typeof world>>,
  draft: Awaited<ReturnType<Awaited<ReturnType<typeof world>>['draft']>>,
): Promise<unknown> {
  return runCommand(
    w.services,
    w.commands.update,
    {
      id: draft.id,
      revision: draft.revision - 1,
      name: draft.name,
      folderId: null,
      mailboxId: draft.mailboxId,
      fromName: null,
      replyTo: null,
      subject: 'Changed',
      preheader: null,
      content: draft.content,
      audience: draft.audience,
    },
    w.as(),
  );
}

describe('the audience and the checks', () => {
  it('counts who will not get it by the reason the pipeline would give, with examples', async () => {
    const w = await world();
    const good = [await w.contact(), await w.contact(), await w.contact()];
    const unknown = await w.contact({ consent: 'none' });
    const withdrawn = await w.contact({ consent: 'withdrawn' });
    const nowhere = await w.contact({ email: null });
    const blocked = await w.contact();
    const quiet = await w.contact();
    const suppressed = {
      hard_bounce: await w.contact({ email: 'bounced@example.test' }),
      unsubscribe: await w.contact({ email: 'left@example.test' }),
      complaint: await w.contact({ email: 'angry@example.test' }),
      manual: await w.contact({ email: 'manual@example.test' }),
    };
    await w.contact({ tagged: false });
    await w.inTenant(async (trx) => {
      await trx
        .updateTable('crm.contacts')
        .set({ do_not_contact: true })
        .where('id', '=', blocked)
        .execute();
      await trx
        .updateTable('crm.contacts')
        .set({ dnd_channels: ['email'] })
        .where('id', '=', quiet)
        .execute();
      await trx
        .insertInto('messaging.suppressions')
        .values(
          Object.entries({
            hard_bounce: 'bounced@example.test',
            unsubscribe: 'left@example.test',
            complaint: 'angry@example.test',
            manual: 'manual@example.test',
          }).map(([reason, address]) => ({
            business_id: w.business.id,
            channel: 'email',
            address_normalized: address,
            reason,
          })),
        )
        .execute();
    });
    const campaign = await w.draft();
    const preview = emailCampaignAudiencePreview.parse(
      await w.inTenant(async (trx) => {
        const row = await requireCampaign(trx, w.context, campaign.id);
        return readAudiencePreview(trx, w.as(), row, audienceOf(row), w.options);
      }),
    );
    expect(preview).toMatchObject({ total: 12, willReceive: 3, willNot: 9, tooMany: false });
    expect(Object.fromEntries(preview.reasons.map((group) => [group.reason, group.count]))).toEqual(
      {
        do_not_contact: 2,
        unsubscribed: 2,
        no_consent: 1,
        no_email: 1,
        bounced: 1,
        complained: 1,
        suppressed: 1,
      },
    );
    expect(preview.receiving.map((sample) => sample.contactId).sort()).toEqual(
      good.map((id) => toPublicId('contact', id)).sort(),
    );
    const sampleOf = (reason: string) =>
      preview.reasons.find((group) => group.reason === reason)?.sample.map((s) => s.contactId);
    expect(sampleOf('no_consent')).toEqual([toPublicId('contact', unknown)]);
    expect(sampleOf('no_email')).toEqual([toPublicId('contact', nowhere)]);
    expect(sampleOf('bounced')).toEqual([toPublicId('contact', suppressed.hard_bounce)]);

    // The same verdicts as the pipeline's own policy, contact by contact.
    await w.inTenant(async (trx) => {
      for (const [contactId, action] of [
        [good[0], 'allow'],
        [unknown, 'refuse'],
        [withdrawn, 'refuse'],
        [blocked, 'refuse'],
        [quiet, 'refuse'],
        [suppressed.manual, 'refuse'],
      ] as const) {
        const identity = await trx
          .selectFrom('crm.contact_identities')
          .select('id')
          .where('contact_id', '=', contactId ?? '')
          .executeTakeFirstOrThrow();
        const decision = await readOutboundPolicy(trx, {
          identityId: identity.id,
          accountId: w.mailboxId,
          channel: 'email',
          purpose: 'marketing',
        });
        expect(decision.action).toBe(action);
      }
    });

    // With quiet hours on, a contact whose own time zone nobody knows is timed by the
    // business's: nobody is left out for want of one.
    await w.inTenant((trx) =>
      trx.updateTable('messaging.settings').set({ quiet_hours_enabled: true }).execute(),
    );
    const timed = await w.inTenant(async (trx) => {
      const row = await requireCampaign(trx, w.context, campaign.id);
      return readAudiencePreview(trx, w.as(), row, audienceOf(row), w.options);
    });
    expect(timed.willReceive).toBe(preview.willReceive);
    expect(timed.reasons.find((group) => group.reason === 'no_time_zone')).toBeUndefined();
  });

  it('reads every kind of audience as the contact list would', async () => {
    const w = await world();
    const ada = await w.contact({ firstName: 'Ada' });
    await w.contact({ firstName: 'Grace', tagged: false });
    const other = await database.fixtures.user();
    const views = await w.inTenant(async (trx) => {
      const type = await trx
        .selectFrom('crm.object_types')
        .select('id')
        .where('kind', '=', 'contact')
        .executeTakeFirstOrThrow();
      const deals = await trx
        .selectFrom('crm.object_types')
        .select('id')
        .where('kind', '=', 'deal')
        .executeTakeFirstOrThrow();
      const mine = await trx
        .insertInto('crm.saved_views')
        .values({
          business_id: w.business.id,
          object_type_id: type.id,
          name: 'New VIPs',
          owner_user_id: w.user.id,
          filters: JSON.stringify({
            added: 'week',
            sort: 'name',
            filter: {
              match: 'all',
              groups: [
                {
                  match: 'all',
                  conditions: [
                    { field: 'tags', operator: 'any_of', values: [toPublicId('tag', w.tagId)] },
                  ],
                },
              ],
            },
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const pipeline = await trx
        .insertInto('crm.saved_views')
        .values({
          business_id: w.business.id,
          object_type_id: deals.id,
          name: 'Deals',
          owner_user_id: w.user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { mine: mine.id, pipeline: pipeline.id };
    });
    const count = async (audience: object | null) => {
      const campaign = await w.draft({ audience: audience as never });
      return w.inTenant(async (trx) => {
        const row = await requireCampaign(trx, w.context, campaign.id);
        return readAudiencePreview(trx, w.as(), row, audienceOf(row), w.options);
      });
    };
    expect((await count({ kind: 'all' })).total).toBe(2);
    expect((await count(null)).total).toBe(0);
    expect(
      (
        await count({
          kind: 'tags',
          tagIds: [toPublicId('tag', w.tagId)],
          match: 'all',
        })
      ).receiving.map((sample) => sample.contactId),
    ).toEqual([toPublicId('contact', ada)]);
    expect(
      (
        await count({
          kind: 'filter',
          filter: {
            match: 'all',
            groups: [
              {
                match: 'all',
                conditions: [{ field: 'firstName', operator: 'is', value: 'Grace' }],
              },
            ],
          },
        })
      ).total,
    ).toBe(1);
    expect(
      (await count({ kind: 'smart_list', viewId: toPublicId('saved_view', views.mine) })).total,
    ).toBe(1);

    // A view of deals, and a private view read by someone else, are no audience.
    const checksOf = async (audience: object, invocation = w.as()) => {
      const campaign = await w.draft({ audience: audience as never });
      return w.inTenant(async (trx) =>
        readCampaignChecks(
          trx,
          invocation,
          await requireCampaign(trx, w.context, campaign.id),
          w.options,
        ),
      );
    };
    const deals = await checksOf({
      kind: 'smart_list',
      viewId: toPublicId('saved_view', views.pipeline),
    });
    expect(deals.items.map((item) => item.code)).toContain('audience_unavailable');
    const campaign = await w.draft({
      audience: { kind: 'smart_list', viewId: toPublicId('saved_view', views.mine) },
    });
    const stranger = {
      ...w.as(),
      context: { ...w.context, actorId: other.id, userId: other.id },
    };
    const theirs = await withTenant(db, stranger.context, async (trx) =>
      readCampaignChecks(
        trx,
        stranger,
        await requireCampaign(trx, stranger.context, campaign.id),
        w.options,
      ),
    );
    expect(theirs.items.map((item) => item.code)).toContain('audience_unavailable');
    expect(theirs.canSend).toBe(false);
  });

  it('names what stands in the way of sending, and refuses to send past it', async () => {
    const w = await world();
    await w.contact();
    await w.contact({ consent: 'none' });
    const codes = async (campaign: { id: string }, options = w.options) =>
      emailCampaignChecks.parse(
        await w.inTenant(async (trx) =>
          readCampaignChecks(
            trx,
            w.as(),
            await requireCampaign(trx, w.context, campaign.id),
            options,
          ),
        ),
      );

    const ready = await w.draft();
    const fine = await codes(ready);
    expect(fine.canSend).toBe(true);
    expect(fine.dailyCeiling).toBe(1000);
    expect(fine.items.map((item) => [item.code, item.severity])).toEqual([
      ['unsubscribe_line_added', 'info'],
      ['some_will_not_receive', 'warning'],
    ]);
    // Without a postal address on the business profile the campaign cannot be sent (15
    // U.S.C. 7704(a)(5)(A)(iii)).
    await database.as('postgres', (sql) =>
      sql.query('update tenancy.businesses set address = null where id = $1', [w.business.id]),
    );
    const homeless = await codes(ready);
    expect(homeless.canSend).toBe(false);
    expect(homeless.items.find((item) => item.code === 'postal_address_missing')).toEqual({
      code: 'postal_address_missing',
      severity: 'blocking',
      message:
        'Your business profile has no postal address. US law (CAN-SPAM) requires every marketing email to show a valid physical postal address: a street address, or a PO box or private mailbox registered for mail. Add it in Settings → Business profile; it is added to the end of every campaign email.',
    });
    await database.as('postgres', (sql) =>
      sql.query(
        `update tenancy.businesses set address = '{"line1":"12 High St","city":"Austin"}' where id = $1`,
        [w.business.id],
      ),
    );

    const blank = await runCommand(w.services, w.commands.create, { name: 'Blank' }, w.as());
    expect((await codes(blank)).items.map((item) => item.code)).toEqual([
      'subject_missing',
      'body_missing',
      'unsubscribe_line_added',
      'audience_missing',
      'mailbox_missing',
    ]);
    await expect(
      runCommand(w.services, w.commands.send, { id: blank.id, revision: 1 }, w.as()),
    ).rejects.toMatchObject({
      issues: [
        { code: 'subject_missing' },
        { code: 'body_missing' },
        { code: 'audience_missing' },
        { code: 'mailbox_missing' },
      ],
    });

    const html = await w.draft({
      subject: `${'A long subject '.repeat(5)}{{contact.nickname}} {{trigger_link.offer}}`,
      content: {
        format: 'html',
        html: ' ',
        text: 'See {{email.unsubscribe_link}} and {{contact.shoeSize}}',
      },
      audience: { kind: 'tags', tagIds: [toPublicId('tag', randomUUIDv7())], match: 'any' },
    });
    const broken = await codes(html);
    expect(broken.items.map((item) => item.code)).toEqual([
      'subject_long',
      'body_missing',
      'unfillable_merge_fields',
      'unsubscribe_line_added',
      'audience_unavailable',
    ]);
    expect(broken.items.find((item) => item.code === 'unfillable_merge_fields')?.fields).toEqual([
      'contact.nickname',
      'contact.shoeSize',
    ]);
    const textless = await w.draft({
      content: { format: 'html', html: '<p>{{email.unsubscribe_link}}</p>', text: ' ' },
    });
    expect((await codes(textless)).items.map((item) => item.code)).toContain('text_part_missing');
    const placed = await w.draft({
      content: { format: 'text', text: 'Bye: {{email.unsubscribe_link}}' },
    });
    expect((await codes(placed)).items.map((item) => item.code)).not.toContain(
      'unsubscribe_line_added',
    );

    // With an address on the profile nothing is said of it.
    await database.as('crm_owner', (owner) =>
      owner.query(
        `update tenancy.businesses set address = '{"line1": "12 High St", "city": "Austin"}' where id = $1`,
        [w.business.id],
      ),
    );
    expect((await codes(ready)).items.map((item) => item.code)).not.toContain(
      'postal_address_missing',
    );
    await database.as('crm_owner', (owner) =>
      owner.query(`update tenancy.businesses set address = null where id = $1`, [w.business.id]),
    );

    // Nobody who can receive it, and nobody at all.
    await w.inTenant((trx) =>
      trx.updateTable('crm.contacts').set({ do_not_contact: true }).execute(),
    );
    expect((await codes(ready)).items.map((item) => item.code)).toContain('audience_empty');
    const nobody = await w.draft({
      audience: {
        kind: 'filter',
        filter: {
          match: 'all',
          groups: [
            { match: 'all', conditions: [{ field: 'firstName', operator: 'is', value: 'Zed' }] },
          ],
        },
      },
    });
    expect(
      (await codes(nobody)).items.find((item) => item.code === 'audience_empty')?.message,
    ).toBe('Nobody matches this audience.');
    await w.inTenant((trx) =>
      trx.updateTable('crm.contacts').set({ do_not_contact: false }).execute(),
    );

    // A draft may be saved with no mailbox at all.
    expect((await w.draft({ mailboxId: null })).mailboxId).toBeNull();

    // The mailbox: its use, its state and each setup check.
    await w.setupChecked({ spf: 'fail', dkim: 'could_not_check', dmarc: 'not_applicable' });
    await w.inTenant(async (trx) => {
      await trx
        .updateTable('messaging.mailboxes')
        .set({ use_for_campaigns: false, use_for_conversations: true, daily_limit: 1 })
        .execute();
      await trx.updateTable('messaging.channel_accounts').set({ status: 'paused' }).execute();
    });
    const mailbox = await codes(ready, { ...w.options, publicUrl: 'http://localhost:3000' });
    expect(mailbox.items.map((item) => [item.code, item.check ?? null])).toEqual([
      ['unsubscribe_line_added', null],
      ['some_will_not_receive', null],
      ['mailbox_inactive', null],
      ['mailbox_not_for_campaigns', null],
      ['mailbox_check_failing', 'spf'],
      ['mailbox_check_unknown', 'dkim'],
      ['mailbox_check_unknown', 'unsubscribe'],
      ['postal_address_missing', null],
      ['unsubscribe_unavailable', null],
    ]);
    // One a day, less the fifth kept for conversations, leaves no campaign email today.
    expect(mailbox.dailyCeiling).toBe(0);
    expect((await codes(ready, { ...w.options, publicUrl: undefined })).canSend).toBe(false);

    // A mailbox never checked, and one that is gone.
    await database.as('crm_owner', (owner) =>
      owner.query('delete from messaging.mailbox_check_runs where business_id = $1', [
        w.business.id,
      ]),
    );
    expect((await codes(ready)).items.map((item) => item.code)).toContain('mailbox_not_checked');
    await w.inTenant((trx) =>
      trx.updateTable('messaging.email_campaigns').set({ mailbox_id: null }).execute(),
    );
    expect(
      (await codes(ready)).items.find((item) => item.code === 'mailbox_missing')?.message,
    ).toBe('Choose the mailbox to send from.');
  });

  it('says when the limits spread a send over days', async () => {
    const w = await world();
    for (let index = 0; index < 5; index += 1) await w.contact();
    await runCommand(w.services, w.commands.settings, { dailyLimit: 2 }, w.as());
    const campaign = await w.draft();
    const checks = await w.inTenant(async (trx) =>
      readCampaignChecks(
        trx,
        w.as(),
        await requireCampaign(trx, w.context, campaign.id),
        w.options,
      ),
    );
    expect(checks.dailyCeiling).toBe(2);
    expect(checks.items.find((item) => item.code === 'spread_over_days')).toMatchObject({
      severity: 'warning',
      days: 3,
      count: 2,
    });
    expect(checks.canSend).toBe(true);
  });
});

describe('sending', () => {
  it('sends each consenting contact one email of their own and skips the rest with a reason', async () => {
    const w = await world();
    const ada = await w.contact({ firstName: 'Ada', email: 'ada@example.test' });
    const grace = await w.contact({ firstName: 'Grace & <Co>', email: 'grace@example.test' });
    const unknown = await w.contact({ consent: 'none' });
    const nowhere = await w.contact({ email: null });
    const nameless = await w.contact({ email: 'nameless@example.test' });
    await w.inTenant((trx) =>
      trx
        .updateTable('crm.contacts')
        .set({ first_name: null })
        .where('id', '=', nameless)
        .execute(),
    );
    const campaign = await w.draft({
      fromName: 'Dana at Harbor Lights',
      replyTo: 'dana@example.test',
      preheader: 'Doors open at ten',
      content: {
        format: 'html',
        html: '<html><body><h1>Hi {{contact.firstName}}</h1></body></html>',
        text: 'Hi {{contact.firstName}}',
      },
    });
    const sending = await w.send(campaign);
    expect(sending).toMatchObject({
      status: 'sending',
      schedule: { sendAt: null, batches: null },
    });
    // Once it is sent it cannot be edited or deleted, and cannot be sent again.
    await expect(
      staleSave(w, { ...campaign, revision: campaign.revision + 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(w.send(campaign)).rejects.toBeInstanceOf(ConflictError);
    await expect(
      runCommand(
        w.services,
        w.commands.remove,
        { id: campaign.id, revision: campaign.revision },
        w.as(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    await w.drive(campaign);
    expect(w.handed.map((mail) => mail.to).sort()).toEqual([
      'ada@example.test',
      'grace@example.test',
    ]);
    const toAda = w.handed.find((mail) => mail.to === 'ada@example.test');
    const toGrace = w.handed.find((mail) => mail.to === 'grace@example.test');
    expect(toAda).toMatchObject({
      from: { address: 'news@example.test', name: 'Dana at Harbor Lights' },
      replyTo: 'dana@example.test',
      subject: 'Hello Ada',
    });
    // One-click unsubscribe (RFC 8058) and the same address, visible, in both parts.
    expect(toAda?.unsubscribeUrl).toMatch(
      new RegExp(`^${PUBLIC_URL}/unsubscribe/[A-Za-z0-9_-]{43}$`),
    );
    // And the business's postal address (15 U.S.C. 7704(a)(5)(A)(iii)).
    const postal = '12 High St, Austin, TX 78701, US';
    expect(toAda?.text).toMatch(
      new RegExp(
        `^Hi Ada\\n\\n--\\nBusiness [^\\n]+, ${postal}\\nUnsubscribe: ${toAda?.unsubscribeUrl ?? ''}\\n$`,
      ),
    );
    expect(toAda?.html).toContain(
      `${postal}<br><a href="${toAda?.unsubscribeUrl ?? ''}">Unsubscribe</a></p></body>`,
    );
    expect(toAda?.html).toContain('<body><div style="display:none');
    expect(toAda?.html).toContain('Doors open at ten</div><h1>Hi Ada</h1>');
    expect(toGrace?.unsubscribeUrl).not.toBe(toAda?.unsubscribeUrl);
    // A value never becomes markup.
    expect(toGrace?.html).toContain('<h1>Hi Grace &amp; &lt;Co&gt;</h1>');
    expect(toGrace?.text).toContain('Hi Grace & <Co>');

    const rows = await w.recipients(campaign);
    expect(
      Object.fromEntries(rows.map((row) => [row.contact_id, [row.status, row.reason]])),
    ).toEqual({
      [ada]: ['sent', null],
      [grace]: ['sent', null],
      [unknown]: ['skipped', 'no_consent'],
      [nowhere]: ['skipped', 'no_email'],
      [nameless]: ['skipped', 'missing_merge_values'],
    });
    expect(rows.find((row) => row.contact_id === nameless)?.fields).toEqual(['contact.firstName']);
    const finished = await w.inTenant((trx) => readCampaign(trx, w.as(), campaign.id));
    expect(finished).toMatchObject({
      status: 'sent',
      counts: { audience: 5, pending: 0, queued: 0, sent: 2, skipped: 3, failed: 0 },
      waiting: null,
    });
    expect(finished.finishedAt).not.toBeNull();

    const stats = emailCampaignStats.parse(
      await w.inTenant((trx) => readCampaignStats(trx, w.as(), campaign.id)),
    );
    expect(stats).toMatchObject({
      audience: 5,
      sent: 2,
      skipped: 3,
      failed: 0,
      bounced: 0,
      unsubscribed: 0,
      batches: 1,
    });
    expect(stats.skippedByReason).toEqual([
      { reason: 'missing_merge_values', count: 1 },
      { reason: 'no_consent', count: 1 },
      { reason: 'no_email', count: 1 },
    ]);
    const list = (query: object) =>
      w.inTenant((trx) =>
        readCampaignRecipients(trx, w.as(), campaign.id, { ...listQuery, ...query }),
      );
    const everyone = emailCampaignRecipientList.parse(await list({}));
    expect(everyone.items).toHaveLength(5);
    expect(
      everyone.items.find((item) => item.contactId === toPublicId('contact', ada)),
    ).toMatchObject({
      status: 'sent',
      email: 'ada@example.test',
      batch: 1,
      bounced: false,
      unsubscribed: false,
    });
    expect((await list({ status: 'skipped', reason: 'no_email' })).items).toHaveLength(1);
    const firstPage = await list({ limit: 2 });
    expect(firstPage.next).not.toBeNull();
    expect((await list({ limit: 5, after: firstPage.next })).items).toHaveLength(3);

    // The audience that was fixed is what the preview now shows, and a later run sends nothing.
    const fixed = await w.inTenant(async (trx) => {
      const row = await requireCampaign(trx, w.context, campaign.id);
      return readAudiencePreview(trx, w.as(), row, audienceOf(row), w.options);
    });
    expect(fixed).toMatchObject({ total: 5, willReceive: 2, willNot: 3 });
    await w.tick(campaign);
    expect(await w.dispatch()).toBe(0);
    expect(w.handed).toHaveLength(2);

    // The events say what happened and never what was written.
    const events = await database.as('crm_owner', (owner) =>
      owner.query<{ type: string; payload: Record<string, unknown> }>(
        `select type, payload from events.events where subject_id = $1 order by recorded_at, id`,
        [w.uuidOf(campaign)],
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      'campaign.created',
      'campaign.updated',
      'campaign.started',
      'campaign.sent',
    ]);
    expect(events.at(-1)?.payload).toEqual({
      name: 'Spring open day',
      audience: 5,
      sent: 2,
      skipped: 3,
      failed: 0,
    });
    const audit = await database.as('crm_owner', (owner) =>
      owner.query<{ input: unknown }>(
        `select input from audit.commands where business_id = $1 and command like 'campaign.%'`,
        [w.business.id],
      ),
    );
    expect(JSON.stringify(audit)).not.toContain('Doors open');
    expect(JSON.stringify(audit)).not.toContain('Hi {{contact');
  });

  it('sends nothing before a scheduled time, and a scheduled campaign can be taken back', async () => {
    const w = await world();
    await w.contact();
    const campaign = await w.draft();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const schedule = (sendAt: string, revision = campaign.revision) =>
      runCommand(w.services, w.commands.schedule, { id: campaign.id, revision, sendAt }, w.as());
    await expect(schedule(at(-60_000))).rejects.toBeInstanceOf(ValidationError);
    await expect(schedule(at(400 * 86_400_000))).rejects.toBeInstanceOf(ValidationError);
    const sendAt = at(3_600_000);
    const scheduled = await schedule(sendAt);
    expect(scheduled).toMatchObject({ status: 'scheduled', schedule: { sendAt, batches: null } });

    await w.tick(campaign);
    expect(await w.recipients(campaign)).toEqual([]);
    expect((await w.row(campaign)).status).toBe('scheduled');

    // Taken back, it is a draft again and can be edited and scheduled anew.
    const back = await runCommand(w.services, w.commands.cancel, { id: campaign.id }, w.as());
    expect(back).toMatchObject({
      status: 'draft',
      schedule: null,
      revision: campaign.revision + 1,
    });
    await schedule(sendAt, back.revision);

    // Its time comes: the sweep finds it, and the task starts and sends it.
    await w.elapse(campaign, '2 hours');
    await w.inTenant((trx) =>
      sql`update messaging.email_campaigns set next_run_at = send_at`.execute(trx),
    );
    expect(await scheduleEmailCampaigns(w.services)).toBeGreaterThanOrEqual(1);
    await w.drive(campaign);
    expect(w.handed).toHaveLength(1);
    expect((await w.row(campaign)).started_at).not.toBeNull();
  });

  it('releases batches of the size asked, a batch interval apart, inside the window', async () => {
    const w = await world();
    for (let index = 0; index < 5; index += 1) await w.contact();
    const campaign = await w.draft();
    await w.send(campaign, { size: 2, every: 1, unit: 'hours' });

    await w.tick(campaign);
    await w.dispatch();
    await w.tick(campaign);
    expect(w.handed).toHaveLength(2);
    const waiting = await w.inTenant((trx) => readCampaign(trx, w.as(), campaign.id));
    expect(waiting).toMatchObject({
      status: 'sending',
      counts: { pending: 3, sent: 2 },
      waiting: { reason: 'batch_interval' },
    });
    expect(waiting.waiting?.until).not.toBeNull();
    // Nothing more leaves however often the task runs before the hour is up.
    await w.tick(campaign);
    expect(await w.dispatch()).toBe(0);

    await w.elapse(campaign, '61 minutes');
    await w.tick(campaign);
    await w.dispatch();
    await w.tick(campaign);
    expect(w.handed).toHaveLength(4);
    expect((await w.row(campaign)).batch_number).toBe(2);

    await w.elapse(campaign, '61 minutes');
    await w.drive(campaign);
    expect(w.handed).toHaveLength(5);
    expect((await w.recipients(campaign)).map((row) => row.batch).sort()).toEqual([1, 1, 2, 2, 3]);
    expect((await w.inTenant((trx) => readCampaignStats(trx, w.as(), campaign.id))).batches).toBe(
      3,
    );

    // A window that is closed now holds everything back until it opens.
    const later = await w.draft();
    const zone = (await w.inTenant((trx) => readCampaign(trx, w.as(), later.id))).timeZone;
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
    );
    const pad = (value: number) => String(value % 24).padStart(2, '0');
    await w.send(later, {
      size: 10,
      every: 1,
      unit: 'days',
      window: { from: `${pad(hour + 2)}:00`, to: `${pad(hour + 3)}:00` },
    });
    await w.tick(later);
    expect(await w.dispatch()).toBe(0);
    expect((await w.inTenant((trx) => readCampaign(trx, w.as(), later.id))).waiting?.reason).toBe(
      'window',
    );
  });

  it('stops at once when paused, goes on without duplicates when resumed, and cancels for good', async () => {
    const w = await world();
    for (let index = 0; index < 4; index += 1) await w.contact();
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ pacing_per_minute: 2 }).execute(),
    );
    const campaign = await w.draft();
    await w.send(campaign);
    // Two are released, the mailbox's pace for a minute; one leaves before the pause.
    await w.tick(campaign);
    const [first] = await w.inTenant((trx) =>
      trx
        .selectFrom('messaging.messages')
        .select('id')
        .where('status', '=', 'queued')
        .orderBy('id')
        .execute(),
    );
    await w.dispatchTask.run(
      { messageId: first?.id ?? '' },
      { invocation: w.system, services: w.services },
    );
    expect(w.handed).toHaveLength(1);

    const paused = await runCommand(w.services, w.commands.pause, { id: campaign.id }, w.as());
    expect(paused.status).toBe('paused');
    await expect(
      runCommand(w.services, w.commands.pause, { id: campaign.id }, w.as()),
    ).rejects.toBeInstanceOf(ConflictError);
    // The email already released is held by the pipeline, and the task releases no more.
    await w.inTenant((trx) =>
      trx
        .updateTable('messaging.outbound_dispatch')
        .set({ reserved_at: null })
        .where('reserved_at', 'is', null)
        .execute(),
    );
    await w.dispatch();
    await w.tick(campaign);
    await w.dispatch();
    expect(w.handed).toHaveLength(1);
    const held = await w.inTenant((trx) =>
      trx
        .selectFrom('messaging.messages')
        .select(['status', 'error_code'])
        .where('status', '=', 'queued')
        .execute(),
    );
    expect(held).toEqual([{ status: 'queued', error_code: 'campaign_paused' }]);
    expect((await w.row(campaign)).pending_count).toBe(2);

    const resumed = await runCommand(w.services, w.commands.resume, { id: campaign.id }, w.as());
    expect(resumed.status).toBe('sending');
    // The held email goes when it is next looked at; pacing is put aside for the test.
    await w.inTenant(async (trx) => {
      await trx.updateTable('messaging.messages').set({ scheduled_for: null }).execute();
      await trx.updateTable('messaging.mailboxes').set({ pacing_per_minute: 600 }).execute();
    });
    await w.dispatch();
    await w.drive(campaign);
    // Everyone has it, once.
    expect(w.handed).toHaveLength(4);
    expect(new Set(w.handed.map((mail) => mail.to)).size).toBe(4);
    expect((await w.row(campaign)).next_run_at).toBeNull();
    for (const command of [w.commands.resume, w.commands.cancel])
      await expect(
        runCommand(w.services, command, { id: campaign.id }, w.as()),
      ).rejects.toBeInstanceOf(ConflictError);
  });

  it('cancels for good: whoever is pending is skipped, and what was released is refused', async () => {
    const w = await world();
    await w.contact();
    await w.contact();
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ pacing_per_minute: 1 }).execute(),
    );
    const campaign = await w.draft();
    await w.send(campaign);
    // One is released and one is still pending when it is cancelled.
    await w.tick(campaign);
    expect((await w.recipients(campaign)).map((row) => row.status)).toEqual(['queued', 'pending']);
    const cancelled = await runCommand(w.services, w.commands.cancel, { id: campaign.id }, w.as());
    expect(cancelled.status).toBe('cancelled');
    expect((await w.recipients(campaign)).map((row) => [row.status, row.reason])).toEqual([
      ['queued', null],
      ['skipped', 'cancelled'],
    ]);
    await w.dispatch();
    await w.tick(campaign);
    expect(w.handed).toEqual([]);
    expect((await w.recipients(campaign)).map((row) => [row.status, row.reason])).toEqual([
      ['skipped', 'cancelled'],
      ['skipped', 'cancelled'],
    ]);
    expect(await w.row(campaign)).toMatchObject({ status: 'cancelled', next_run_at: null });
  });

  it('sends nobody twice when a run dies half-way through a batch', async () => {
    const w = await world();
    const contacts = [await w.contact(), await w.contact(), await w.contact()];
    const campaign = await w.draft();
    await w.send(campaign);
    // The worker dies while the second recipient is being filled in.
    w.options.failOn = contacts[1] ?? '';
    await expect(w.tick(campaign)).rejects.toThrow('the worker died');
    // Nothing of the batch was kept: no message, and every recipient still pending.
    expect(await w.dispatch()).toBe(0);
    expect((await w.recipients(campaign)).map((row) => row.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    await w.drive(campaign);
    expect(w.handed).toHaveLength(3);
    expect(new Set(w.handed.map((mail) => mail.to)).size).toBe(3);
    // One message per contact, under the key of the campaign and the contact.
    const keys = await w.inTenant((trx) =>
      trx.selectFrom('messaging.messages').select('idempotency_key').execute(),
    );
    expect(keys.map((row) => row.idempotency_key).sort()).toEqual(
      contacts.map((id) => `campaign:${w.uuidOf(campaign)}:${id}`).sort(),
    );
  });

  it("spreads a send over days under the mailbox's limit and the ceilings, and says so", async () => {
    const w = await world({ agencyDailyLimit: 4 });
    for (let index = 0; index < 6; index += 1) await w.contact();
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ daily_limit: 2 }).execute(),
    );
    const campaign = await w.draft();
    await w.send(campaign);
    const round = async () => {
      await w.tick(campaign);
      await w.dispatch();
      await w.tick(campaign);
      return w.inTenant((trx) => readCampaign(trx, w.as(), campaign.id));
    };
    const dayOne = await round();
    expect(w.handed).toHaveLength(2);
    expect(dayOne).toMatchObject({
      status: 'sending',
      counts: { sent: 2, pending: 4 },
      waiting: { reason: 'mailbox_daily_limit' },
    });
    expect(dayOne.waiting?.until).not.toBeNull();

    // A day later the mailbox has room again; the business's own ceiling is the next limit.
    const aDayOn = () =>
      w.inTenant(async (trx) => {
        await sql`update messaging.outbound_dispatch set reserved_at = reserved_at - interval '25 hours'`.execute(
          trx,
        );
      });
    await aDayOn();
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ daily_limit: 100 }).execute(),
    );
    await runCommand(w.services, w.commands.settings, { dailyLimit: 3 }, w.as());
    const dayTwo = await round();
    expect(w.handed).toHaveLength(3);
    expect(dayTwo.waiting).toMatchObject({ reason: 'business_daily_limit', until: null });

    // Then the agency's, counted over every business of the agency.
    await runCommand(w.services, w.commands.settings, { dailyLimit: null }, w.as());
    const dayThree = await round();
    expect(w.handed).toHaveLength(4);
    expect(dayThree.waiting?.reason).toBe('agency_daily_limit');

    // A day on again, the rest goes and the campaign is finished.
    await w.inTenant(async (trx) => {
      await sql`update messaging.email_campaign_recipients set released_at = released_at - interval '25 hours'`.execute(
        trx,
      );
    });
    await w.drive(campaign);
    expect(w.handed).toHaveLength(6);
    expect(new Set(w.handed.map((mail) => mail.to)).size).toBe(6);
  });

  it('never queues more than a minute of campaign mail, so a reply goes out first', async () => {
    const w = await world();
    const contacts: string[] = [];
    for (let index = 0; index < 6; index += 1) contacts.push(await w.contact());
    await w.inTenant((trx) =>
      trx
        .updateTable('messaging.mailboxes')
        .set({ pacing_per_minute: 3, use_for_conversations: true })
        .execute(),
    );
    const campaign = await w.draft();
    await w.send(campaign);
    await w.tick(campaign);
    // Three of six are in the queue: the mailbox's pace, not the backlog.
    const queued = await w.inTenant((trx) =>
      trx
        .selectFrom('messaging.messages')
        .select(['id', 'priority'])
        .where('status', '=', 'queued')
        .execute(),
    );
    expect(queued.map((message) => message.priority)).toEqual([2, 2, 2]);
    expect(
      (await w.inTenant((trx) => readCampaign(trx, w.as(), campaign.id))).waiting,
    ).toMatchObject({
      reason: 'mailbox_pacing',
    });

    // A person's reply queued now has the queue's first priority, ahead of all three.
    const reply = await w.inTenant(async (trx) => {
      const identity = await trx
        .selectFrom('crm.contact_identities')
        .select('id')
        .where('contact_id', '=', contacts[0] ?? '')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.consents')
        .values({
          business_id: w.business.id,
          contact_id: contacts[0] ?? '',
          channel: 'email',
          purpose: 'transactional',
          status: 'granted',
          source: 'user',
          recorded_by_kind: 'system',
        })
        .execute();
      return queueOutboundMessage(trx, w.context, {
        identityId: identity.id,
        accountId: w.mailboxId,
        channel: 'email',
        purpose: 'transactional',
        lane: 'reply',
        idempotencyKey: randomUUID(),
        subject: 'Re: your question',
        text: 'Yes, we are open.',
      });
    });
    const jobs = await database.as('crm_owner', (owner) =>
      owner.query<{ key: string; priority: number }>(
        `select key, priority from graphile_worker.jobs where key like 'outbound:%' order by priority, id`,
      ),
    );
    const mine = jobs.filter((job) =>
      [reply, ...queued.map((message) => message.id)].includes(job.key.slice('outbound:'.length)),
    );
    expect(mine[0]).toEqual({ key: `outbound:${reply}`, priority: 0 });
    expect(mine.slice(1).map((job) => job.priority)).toEqual([2, 2, 2]);
    // Run in the queue's order, the reply is the first thing the mail server is handed.
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ pacing_per_minute: 600 }).execute(),
    );
    await w.dispatch();
    expect(w.handed[0]).toMatchObject({ subject: 'Re: your question' });
    expect(w.handed[0]?.unsubscribeUrl).toBeUndefined();
    expect(w.handed).toHaveLength(4);
  });

  it('skips a contact who unsubscribes while the campaign is still going out', async () => {
    const w = await world();
    const first = await w.contact({ email: 'a.first@example.test' });
    const second = await w.contact({ email: 'b.second@example.test' });
    const both = [first, second].sort();
    const campaign = await w.draft();
    await w.send(campaign, { size: 1, every: 1, unit: 'hours' });
    await w.tick(campaign);
    await w.dispatch();
    expect(w.handed).toHaveLength(1);
    // The first recipient unsubscribes with the link in their email...
    const token = (w.handed[0]?.unsubscribeUrl ?? '').split('/').at(-1) ?? '';
    expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
    // ...and the other one is suppressed before their batch.
    const other = await w.inTenant((trx) =>
      trx
        .selectFrom('crm.contact_identities')
        .select('value_normalized')
        .where('contact_id', '=', both[1] ?? '')
        .executeTakeFirstOrThrow(),
    );
    await w.inTenant((trx) =>
      trx
        .insertInto('messaging.suppressions')
        .values({
          business_id: w.business.id,
          channel: 'email',
          address_normalized: other.value_normalized,
          reason: 'hard_bounce',
        })
        .execute(),
    );
    await w.elapse(campaign, '61 minutes');
    await w.drive(campaign);
    expect(w.handed).toHaveLength(1);
    expect((await w.recipients(campaign)).map((row) => [row.status, row.reason])).toEqual([
      ['sent', null],
      ['skipped', 'bounced'],
    ]);
    const stats = await w.inTenant((trx) => readCampaignStats(trx, w.as(), campaign.id));
    expect(stats).toMatchObject({ sent: 1, unsubscribed: 1, skipped: 1 });
    const listed = await w.inTenant((trx) =>
      readCampaignRecipients(trx, w.as(), campaign.id, listQuery),
    );
    expect(listed.items[0]).toMatchObject({ unsubscribed: true });

    // Neither can be sent the next campaign, so it is not sent at all.
    const next = await w.draft({ audience: { kind: 'all' } });
    await expect(w.send(next)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'audience_empty' })],
    });
  });

  it('writes off an email the mail server refuses, or the policy refuses as it leaves', async () => {
    const w = await world();
    const refused = await w.contact();
    const changed = await w.contact();
    const [one, two] = [refused, changed].sort();
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ pacing_per_minute: 1 }).execute(),
    );
    const campaign = await w.draft();
    await w.send(campaign);
    await w.tick(campaign);
    w.mailServer.outcome = 'rejected';
    await w.dispatch();
    w.mailServer.outcome = 'accepted';
    // The second withdraws consent after their email was released and before it left.
    await w.inTenant(async (trx) => {
      await trx.updateTable('messaging.mailboxes').set({ pacing_per_minute: 600 }).execute();
      await sql`update messaging.outbound_dispatch set reserved_at = reserved_at - interval '1 hour'`.execute(
        trx,
      );
    });
    await w.tick(campaign);
    await w.inTenant((trx) =>
      trx
        .insertInto('messaging.consents')
        .values({
          business_id: w.business.id,
          contact_id: two ?? '',
          channel: 'email',
          purpose: 'marketing',
          status: 'withdrawn',
          source: 'user',
          recorded_by_kind: 'system',
        })
        .execute(),
    );
    await w.drive(campaign);
    expect(w.handed).toEqual([]);
    expect(
      (await w.recipients(campaign)).map((row) => [row.contact_id, row.status, row.reason]),
    ).toEqual([
      [one, 'failed', null],
      [two, 'skipped', 'unsubscribed'],
    ]);
    expect(await w.row(campaign)).toMatchObject({
      status: 'sent',
      failed_count: 1,
      skipped_count: 1,
    });
  });

  it('pauses itself when too many emails hard-bounce or its mailbox is switched off', async () => {
    const w = await world();
    for (let index = 0; index < 6; index += 1) await w.contact();
    const last = await w.contact();
    const campaign = await w.draft();
    await w.send(campaign, { size: 6, every: 1, unit: 'days' });
    await w.tick(campaign);
    await w.dispatch();
    await w.tick(campaign);
    expect(w.handed).toHaveLength(6);
    // A hundred sent in all, six of them back as hard bounces.
    await w.inTenant(async (trx) => {
      await sql`
        with made as (
          insert into crm.records (business_id, kind, object_type_id)
          select ${w.business.id}, 'contact', t.id from crm.object_types t, generate_series(1, 94)
          where t.kind = 'contact' returning id
        ), people as (
          insert into crm.contacts (business_id, id, first_name, created_by_kind)
          select ${w.business.id}, id, 'Bulk', 'system' from made returning id
        )
        insert into messaging.email_campaign_recipients (business_id, campaign_id, contact_id, status, released_at)
        select ${w.business.id}, ${w.uuidOf(campaign)}, id, 'sent', now() from people
      `.execute(trx);
      await trx
        .updateTable('messaging.messages')
        .set({ status: 'bounced', error_code: 'hard_bounce' })
        .where('status', '=', 'sent')
        .execute();
    });
    await w.elapse(campaign, '25 hours');
    await w.tick(campaign);
    expect(await w.row(campaign)).toMatchObject({ status: 'paused', status_reason: 'bounce_rate' });
    expect(await w.dispatch()).toBe(0);
    const stats = await w.inTenant((trx) => readCampaignStats(trx, w.as(), campaign.id));
    expect(stats).toMatchObject({ sent: 100, bounced: 6, hardBounced: 6, pending: 1 });

    // A person who resumes it has seen the bounces: it goes on, counting from now.
    await runCommand(w.services, w.commands.resume, { id: campaign.id }, w.as());
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ use_for_campaigns: false }).execute(),
    );
    await w.tick(campaign);
    expect(await w.row(campaign)).toMatchObject({
      status: 'paused',
      status_reason: 'mailbox_unavailable',
    });
    await w.inTenant((trx) =>
      trx.updateTable('messaging.mailboxes').set({ use_for_campaigns: true }).execute(),
    );
    await runCommand(w.services, w.commands.resume, { id: campaign.id }, w.as());
    await w.drive(campaign);
    expect(w.handed).toHaveLength(7);
    expect((await w.recipients(campaign)).find((row) => row.contact_id === last)?.status).toBe(
      'sent',
    );
    const events = await database.as('crm_owner', (owner) =>
      owner.query<{ payload: { reason?: string; by?: string } }>(
        `select payload from events.events where subject_id = $1 and type = 'campaign.paused' order by recorded_at, id`,
        [w.uuidOf(campaign)],
      ),
    );
    expect(events.map((event) => event.payload.reason)).toEqual([
      'bounce_rate',
      'mailbox_unavailable',
    ]);
  });

  it('skips, as each email is filled in, whoever it cannot be written for', async () => {
    const w = await world();
    const fine = await w.contact({ firstName: 'Ada' });
    const broken = await w.contact({ firstName: 'Two' });
    const lost = await w.contact({ firstName: 'Lost' });
    const surnameless = await w.contact({ firstName: 'Mono' });
    await w.inTenant(async (trx) => {
      await trx
        .updateTable('crm.contacts')
        .set({ last_name: 'Lovelace' })
        .where('id', 'in', [fine, broken, lost])
        .execute();
      // A line break in a value that goes into the subject would start a header.
      await trx
        .updateTable('crm.contacts')
        .set({ first_name: 'Two' + String.fromCharCode(10) + 'Lines' })
        .where('id', '=', broken)
        .execute();
    });
    const campaign = await w.draft({
      content: {
        format: 'html',
        html: '<p>Dear {{contact.firstName}} {{contact.lastName}}</p>',
        text: 'Dear {{contact.firstName}}',
      },
    });
    // Sent in batches inside a window that is closed now: the audience is fixed, and
    // nothing is released yet.
    const zone = (await w.inTenant((trx) => readCampaign(trx, w.as(), campaign.id))).timeZone;
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
    );
    const pad = (value: number) => String(value % 24).padStart(2, '0');
    await w.send(campaign, {
      size: 10,
      every: 1,
      unit: 'hours',
      window: { from: `${pad(hour + 2)}:00`, to: `${pad(hour + 3)}:00` },
    });
    await w.tick(campaign);
    expect((await w.recipients(campaign)).map((row) => row.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    // One contact loses their address before the window opens.
    await database.as('crm_owner', (owner) =>
      owner.query('delete from crm.contact_identities where contact_id = $1', [lost]),
    );
    await w.inTenant((trx) =>
      trx
        .updateTable('messaging.email_campaigns')
        .set({ window_from: null, window_to: null })
        .execute(),
    );
    await w.drive(campaign);
    const rows = await w.recipients(campaign);
    const of = (id: string) => rows.find((row) => row.contact_id === id);
    expect(of(fine)).toMatchObject({ status: 'sent', reason: null });
    expect(of(broken)).toMatchObject({ status: 'skipped', reason: 'refused' });
    expect(of(lost)).toMatchObject({ status: 'skipped', reason: 'no_email' });
    expect(of(surnameless)).toMatchObject({
      status: 'skipped',
      reason: 'missing_merge_values',
      fields: ['contact.lastName'],
    });
    expect(w.handed).toHaveLength(1);
    expect(w.handed[0]?.html).toContain('<p>Dear Ada Lovelace</p>');
  });

  it('writes a large audience a batch of contacts at a time', async () => {
    const w = await world();
    await w.contact();
    await w.inTenant((trx) =>
      sql`
        with made as (
          insert into crm.records (business_id, kind, object_type_id)
          select ${w.business.id}, 'contact', t.id from crm.object_types t, generate_series(1, 2100)
          where t.kind = 'contact' returning id
        )
        insert into crm.contacts (business_id, id, first_name, created_by_kind)
        select ${w.business.id}, id, 'Bulk', 'system' from made
      `.execute(trx),
    );
    const campaign = await w.draft({ audience: { kind: 'all' } });
    await w.send(campaign);
    await w.drive(campaign);
    expect(await w.row(campaign)).toMatchObject({
      status: 'sent',
      audience_count: 2101,
      sent_count: 1,
      skipped_count: 2100,
    });
    expect(w.handed).toHaveLength(1);
  });

  it('fails a campaign whose audience is gone when it starts', async () => {
    const w = await world();
    await w.contact();
    const campaign = await w.draft();
    await w.send(campaign);
    // The tag is deleted between Send and the task's first run.
    await w.inTenant((trx) => trx.deleteFrom('crm.tags').execute());
    await w.tick(campaign);
    expect(await w.row(campaign)).toMatchObject({
      status: 'failed',
      status_reason: 'audience_unavailable',
      next_run_at: null,
    });
    expect(w.handed).toEqual([]);
    // Nobody is left in the audience when the task first runs.
    const emptied = await w.draft({ audience: { kind: 'all' } });
    await w.send(emptied);
    await w.inTenant((trx) =>
      trx
        .updateTable('crm.contacts')
        .set({ deleted_at: sql`now()` })
        .execute(),
    );
    await w.tick(emptied);
    expect(await w.row(emptied)).toMatchObject({
      status: 'failed',
      status_reason: 'audience_empty',
    });
    // A run for a campaign that is gone, or still a draft, does nothing.
    await w.tick({ id: toPublicId('email_campaign', randomUUIDv7()) });
    await w.tick(await w.draft());
  });
});

describe('a test send', () => {
  it('goes only to the addresses named, marked as a test, and is not counted', async () => {
    const w = await world();
    const ada = await w.contact({ firstName: 'Ada', email: 'ada@example.test' });
    const campaign = await w.draft({
      fromName: 'Dana',
      replyTo: 'dana@example.test',
      subject: 'Hello {{contact.firstName}}',
      content: {
        format: 'html',
        html: '<p>Hi {{contact.firstName}} {{contact.nickname}}</p>',
        text: 'Hi {{contact.firstName}} {{contact.nickname}}',
      },
    });
    const run = async (input: object, invocation = w.as()) => {
      const queued = await runCommand(
        w.services,
        w.test,
        { id: campaign.id, ...input },
        invocation,
      );
      const tests = await w.inTenant((trx) =>
        trx
          .selectFrom('messaging.email_campaign_tests')
          .select('id')
          .where('status', '=', 'queued')
          .execute(),
      );
      for (const { id } of tests)
        await w.testTask.run({ testId: id }, { invocation: w.system, services: w.services });
      return queued;
    };
    expect(await run({ to: ['me', 'Boss@Example.test', 'me'] })).toEqual({
      queued: 2,
      to: [w.user.email, 'boss@example.test'],
    });
    expect(w.handed.map((mail) => mail.to)).toEqual([w.user.email, 'boss@example.test']);
    // As written where there is no contact to fill it in from; no working unsubscribe link.
    expect(w.handed[0]).toMatchObject({
      from: { address: 'news@example.test', name: 'Dana' },
      replyTo: 'dana@example.test',
      subject: '[Test] Hello {{contact.firstName}}',
      unsubscribeUrl: undefined,
    });
    expect(w.handed[0]?.text).toContain('Hi {{contact.firstName}} {{contact.nickname}}');
    expect(w.handed[0]?.text).toContain(`Unsubscribe: ${TEST_UNSUBSCRIBE_NOTE}`);
    expect(w.handed[0]?.html).toContain(`href="${TEST_UNSUBSCRIBE_NOTE}"`);

    // Filled in from a contact, who is sent nothing; a field with no value stays visible.
    w.handed.length = 0;
    await run({ to: ['me'], contactId: toPublicId('contact', ada) });
    expect(w.handed).toHaveLength(1);
    expect(w.handed[0]).toMatchObject({ to: w.user.email, subject: '[Test] Hello Ada' });
    expect(w.handed[0]?.text).toContain('Hi Ada {{contact.nickname}}');
    expect(await w.recipients(campaign)).toEqual([]);
    expect((await w.row(campaign)).status).toBe('draft');
    await expect(
      run({ to: ['me'], contactId: toPublicId('contact', randomUUIDv7()) }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // A test the mail server does not take is marked failed and is not sent again.
    w.handed.length = 0;
    w.mailServer.outcome = 'throws';
    await run({ to: ['me'] });
    w.mailServer.outcome = 'accepted';
    const states = await w.inTenant((trx) =>
      trx.selectFrom('messaging.email_campaign_tests').select('status').orderBy('id').execute(),
    );
    expect(states.map((state) => state.status)).toEqual(['sent', 'sent', 'failed']);
    expect(w.handed).toEqual([]);

    // A plain-text campaign with no name or reply address of its own: the mailbox's.
    const plain = await w.draft({ mailboxId: campaign.mailboxId });
    w.handed.length = 0;
    await runCommand(w.services, w.test, { id: plain.id, to: ['me'] }, w.as());
    const [queuedTest] = await w.inTenant((trx) =>
      trx
        .selectFrom('messaging.email_campaign_tests')
        .select('id')
        .where('status', '=', 'queued')
        .execute(),
    );
    const job = { invocation: w.system, services: w.services };
    await w.testTask.run({ testId: queuedTest?.id ?? '' }, job);
    // The job taken a second time finds the test done and sends nothing.
    await w.testTask.run({ testId: queuedTest?.id ?? '' }, job);
    expect(w.handed).toHaveLength(1);
    expect(w.handed[0]).toMatchObject({
      from: { address: 'news@example.test', name: 'Harbor Lights' },
      replyTo: undefined,
      html: undefined,
    });

    // Someone who may write campaigns may test to themselves, and to nobody else.
    const member = w.as(everythingBut('campaigns.send'));
    await run({ to: ['me'] }, member);
    await expect(run({ to: ['someone@example.test'] }, member)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // An API key has no address of its own.
    await expect(
      run({ to: ['me'] }, { ...w.as(), context: { ...w.system.context, actorKind: 'api_key' } }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Twenty an hour for the business, and nothing before there is something to send.
    await w.inTenant((trx) =>
      sql`insert into messaging.email_campaign_tests (business_id, campaign_id, addresses, requested_by_kind, status, created_at)
          select ${w.business.id}, ${w.uuidOf(campaign)}, array['x@example.test'], 'user', 'sent',
            now() - (n || ' minutes')::interval
          from generate_series(1, 20) n`.execute(trx),
    );
    await expect(run({ to: ['me'] })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'too_many_tests' })],
    });
    const blank = await runCommand(w.services, w.commands.create, { name: 'Blank' }, w.as());
    const testOf = (id: string) => runCommand(w.services, w.test, { id, to: ['me'] }, w.as());
    await expect(testOf(blank.id)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'mailbox_missing' })],
    });
    const empty = await w.draft({ subject: '' });
    await expect(testOf(empty.id)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'body_missing' })],
    });
  });
});

describe('who may', () => {
  it('lets a member draft and not send, and shows another business nothing', async () => {
    const w = await world();
    await w.contact();
    const member = w.as(everythingBut('campaigns.send'));
    const campaign = await w.draft({}, member);
    expect(campaign).toMatchObject({ canManage: true, canSend: false });
    await expect(w.send(campaign, null, member)).rejects.toBeInstanceOf(ForbiddenError);
    for (const command of [w.commands.pause, w.commands.resume, w.commands.cancel])
      await expect(
        runCommand(w.services, command, { id: campaign.id }, member),
      ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runCommand(
        w.services,
        w.commands.schedule,
        {
          id: campaign.id,
          revision: campaign.revision,
          sendAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        member,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const viewer = w.as(['assistant.use']);
    await expect(
      runCommand(w.services, w.commands.create, { name: 'No' }, viewer),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await w.send(campaign);
    await w.drive(campaign);

    // Another business of the same agency, and one of another agency.
    const sibling = await database.fixtures.business(w.agency.id);
    const stranger = await world();
    for (const context of [
      { ...sibling.context, actorKind: 'user' as const, userId: w.user.id, actorId: w.user.id },
      stranger.context,
    ]) {
      const invocation = { context, permissions: 'all' as const };
      await withTenant(db, context, async (trx) => {
        expect(await readCampaigns(trx, invocation, listQuery)).toMatchObject({
          items: [],
          total: 0,
        });
        expect(await readCampaignFolders(trx, invocation)).toMatchObject({
          items: [],
          counts: { all: 0, unfiled: 0 },
        });
        await expect(readCampaign(trx, invocation, campaign.id)).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(
          await trx.selectFrom('messaging.email_campaign_recipients').selectAll().execute(),
        ).toEqual([]);
        expect(
          await trx.selectFrom('messaging.email_campaign_tests').selectAll().execute(),
        ).toEqual([]);
      });
      await expect(
        runCommand(w.services, w.commands.cancel, { id: campaign.id }, invocation),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
