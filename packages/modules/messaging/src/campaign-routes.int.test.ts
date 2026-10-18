// The campaign routes as the server runs them: every operation, each answer checked against
// the schema the API documents, and each permission enforced, reading included. Real
// Postgres.
import type { ApiRoute, Invocation } from '@repo/commands';
import {
  emailCampaign,
  emailCampaignEndpoints,
  emailCampaignFolder,
  emailCampaignList,
  permissions,
  type Permission,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, toPublicId, ValidationError } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { campaignWorld, type CampaignWorld } from '../test/campaigns.js';
import { createCampaignRoutes } from './campaign-routes.js';

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

const everythingBut = (...denied: Permission[]): readonly Permission[] =>
  permissions.filter((each) => !denied.includes(each));

/** Calls a route as the server does, and checks the answer against its documented schema. */
function caller(w: CampaignWorld, routes: readonly ApiRoute[]) {
  return async (
    operationId: string,
    request: { params?: unknown; query?: unknown; body?: unknown } = {},
    invocation: Invocation = w.as(),
  ): Promise<unknown> => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`No route for ${operationId}.`);
    const answer = await route.run(
      {
        invocation,
        params: request.params ?? {},
        query: request.query ?? {},
        body: request.body,
      },
      w.services,
    );
    const schema = route.endpoint.response.schema;
    if (schema === undefined) {
      expect(route.endpoint.response.status).toBe(204);
      expect(answer).toBeUndefined();
      return undefined;
    }
    return schema.parse(answer);
  };
}

it('serves every campaign operation, from a draft to its results', async () => {
  const w = await campaignWorld(database, db, vault);
  const routes = createCampaignRoutes(w.options);
  expect(routes.map((route) => route.endpoint.operationId).sort()).toEqual(
    emailCampaignEndpoints.map((endpoint) => endpoint.operationId).sort(),
  );
  const call = caller(w, routes);
  await w.contact();

  const folder = emailCampaignFolder.parse(
    await call('createEmailCampaignFolder', { body: { name: 'Spring' } }),
  );
  const renamed = emailCampaignFolder.parse(
    await call('updateEmailCampaignFolder', {
      params: { id: folder.id },
      body: { revision: folder.revision, name: 'Spring 2027' },
    }),
  );
  expect(await call('listEmailCampaignFolders')).toMatchObject({
    canManage: true,
    items: [{ id: folder.id, name: 'Spring 2027', campaignCount: 0 }],
  });

  const created = emailCampaign.parse(
    await call('createEmailCampaign', { body: { name: 'Open day', folderId: folder.id } }),
  );
  const draft = emailCampaign.parse(
    await call('updateEmailCampaign', {
      params: { id: created.id },
      body: {
        revision: created.revision,
        name: 'Open day',
        folderId: folder.id,
        mailboxId: toPublicId('mailbox', w.mailboxId),
        fromName: null,
        replyTo: null,
        subject: 'Hello {{contact.firstName}}',
        preheader: null,
        content: { format: 'text', text: 'Come along.' },
        audience: w.tagAudience,
      },
    }),
  );
  // Each row of the list carries its audience, so no screen reads every campaign for it.
  expect(emailCampaignList.parse(await call('listEmailCampaigns')).items).toEqual([
    expect.objectContaining({ id: draft.id, audience: w.tagAudience }),
  ]);
  expect(await call('getEmailCampaign', { params: { id: draft.id } })).toMatchObject({
    name: 'Open day',
    revision: 2,
  });
  expect(await call('getEmailCampaignAudience', { params: { id: draft.id } })).toMatchObject({
    total: 1,
    willReceive: 1,
  });
  expect(await call('getEmailCampaignChecks', { params: { id: draft.id } })).toMatchObject({
    canSend: true,
  });
  expect(
    await call('sendEmailCampaignTest', { params: { id: draft.id }, body: { to: ['me'] } }),
  ).toEqual({ queued: 1, to: [w.user.email] });
  expect(
    await call('moveEmailCampaign', { params: { id: draft.id }, body: { folderId: null } }),
  ).toMatchObject({ folderId: null });
  await call('removeEmailCampaignFolder', {
    params: { id: folder.id },
    body: { revision: renamed.revision },
  });

  const sendAt = new Date(Date.now() + 3_600_000).toISOString();
  expect(
    await call('scheduleEmailCampaign', {
      params: { id: draft.id },
      body: { revision: draft.revision, sendAt },
    }),
  ).toMatchObject({ status: 'scheduled' });
  const back = emailCampaign.parse(await call('cancelEmailCampaign', { params: { id: draft.id } }));
  expect(back.status).toBe('draft');
  expect(
    await call('sendEmailCampaign', {
      params: { id: draft.id },
      body: { revision: back.revision, batches: { size: 10, every: 1, unit: 'hours' } },
    }),
  ).toMatchObject({
    status: 'sending',
    schedule: { batches: { size: 10, every: 1, unit: 'hours', window: null } },
  });
  expect(await call('pauseEmailCampaign', { params: { id: draft.id } })).toMatchObject({
    status: 'paused',
  });
  expect(await call('resumeEmailCampaign', { params: { id: draft.id } })).toMatchObject({
    status: 'sending',
  });
  await w.drive(draft);
  expect(await call('getEmailCampaignStats', { params: { id: draft.id } })).toMatchObject({
    audience: 1,
    sent: 1,
  });
  expect(await call('listEmailCampaignRecipients', { params: { id: draft.id } })).toMatchObject({
    items: [{ status: 'sent', batch: 1 }],
    next: null,
  });

  expect(await call('getEmailCampaignSettings')).toMatchObject({ dailyLimit: null });
  expect(await call('updateEmailCampaignSettings', { body: { dailyLimit: 400 } })).toMatchObject({
    dailyLimit: 400,
  });

  const spare = emailCampaign.parse(await call('createEmailCampaign', { body: { name: 'Spare' } }));
  await call('deleteEmailCampaign', {
    params: { id: spare.id },
    body: { revision: spare.revision },
  });
  await expect(call('listEmailCampaigns', { query: { limit: '0' } })).rejects.toBeInstanceOf(
    ValidationError,
  );
});

it('shows a campaign, its audience and its results only to someone who may write campaigns', async () => {
  const w = await campaignWorld(database, db, vault);
  const call = caller(w, createCampaignRoutes(w.options));
  const draft = await w.draft();
  const viewer = w.as(everythingBut('campaigns.manage', 'campaigns.send'));
  const id = { params: { id: draft.id } };
  for (const [operation, request] of [
    ['listEmailCampaigns', {}],
    ['getEmailCampaign', id],
    ['getEmailCampaignAudience', id],
    ['getEmailCampaignChecks', id],
    ['listEmailCampaignRecipients', id],
    ['getEmailCampaignStats', id],
    ['listEmailCampaignFolders', {}],
    ['listEmailCampaignMailboxes', {}],
    ['getEmailCampaignSettings', {}],
    ['createEmailCampaign', { body: { name: 'No' } }],
    ['createEmailCampaignFolder', { body: { name: 'No' } }],
    ['sendEmailCampaignTest', { ...id, body: { to: ['me'] } }],
  ] as const)
    await expect(call(operation, request, viewer), operation).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  // A member reads and writes, and is told plainly that sending is not theirs.
  const member = w.as(everythingBut('campaigns.send'));
  expect(await call('getEmailCampaign', id, member)).toMatchObject({
    canManage: true,
    canSend: false,
  });
  await expect(
    call('sendEmailCampaign', { ...id, body: { revision: draft.revision } }, member),
  ).rejects.toMatchObject({ permission: 'campaigns.send' });
});

it("lets someone who may write campaigns and not manage mailboxes choose a campaign's mailbox", async () => {
  const w = await campaignWorld(database, db, vault);
  const call = caller(w, createCampaignRoutes(w.options));
  const member = w.as(everythingBut('campaigns.send', 'mailboxes.manage'));
  const answer = await call('listEmailCampaignMailboxes', {}, member);
  expect(answer).toEqual({
    items: [
      {
        id: toPublicId('mailbox', w.mailboxId),
        name: 'Campaign mailbox',
        email: 'news@example.test',
        displayName: 'Harbor Lights',
        status: 'active',
        useForCampaigns: true,
      },
    ],
  });
  // Nothing that signs in to the mailbox or says where its servers are.
  expect(JSON.stringify(answer)).not.toMatch(/localhost|smtp|imap|secret|password/i);
});
