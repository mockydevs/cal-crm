import { expect, it } from 'vitest';

import { bulkContactsInput, contactBulkSkipCodes } from './contact-bulk.js';

const selection = { ids: ['con_01h455vb4pex5vsknk084sn02q'] };

it('adds contacts to one workflow, named by its id, and says why one is skipped', () => {
  expect(
    bulkContactsInput.parse({
      action: 'add_to_workflow',
      workflowId: 'aut_01h455vb4pex5vsknk084sn02q',
      selection,
    }),
  ).toEqual({
    action: 'add_to_workflow',
    workflowId: 'aut_01h455vb4pex5vsknk084sn02q',
    selection,
  });
  // A workflow is named by its id, never by a name or by a tag.
  for (const workflowId of [undefined, 'Welcome', 'tag_01h455vb4pex5vsknk084sn02q'])
    expect(
      bulkContactsInput.safeParse({ action: 'add_to_workflow', workflowId, selection }).success,
    ).toBe(false);
  expect(contactBulkSkipCodes).toEqual(
    expect.arrayContaining(['already_in_workflow', 'reentry_not_allowed', 'workflow_unavailable']),
  );
});

it('takes an export by its columns, built in or a field, each once', () => {
  const columns = ['name', 'email', 'fld_01h455vb4pex5vsknk084sn02q'];
  expect(bulkContactsInput.parse({ action: 'export', columns, selection })).toEqual({
    action: 'export',
    columns,
    selection,
  });
  for (const bad of [[], ['name', 'name'], ['birthday'], ['tag_01h455vb4pex5vsknk084sn02q']])
    expect(bulkContactsInput.safeParse({ action: 'export', columns: bad, selection }).success).toBe(
      false,
    );
});

it('takes an email of its own or a template, and a text of at most 1600 characters', () => {
  const email = { action: 'send_email', selection };
  expect(bulkContactsInput.safeParse({ ...email, subject: 'Hi', body: 'Hello' }).success).toBe(
    true,
  );
  expect(
    bulkContactsInput.safeParse({ ...email, templateId: 'tmpl_01h455vb4pex5vsknk084sn02q' })
      .success,
  ).toBe(true);
  for (const bad of [
    { body: 'Hello' },
    { subject: 'Hi' },
    { subject: 'Two\nlines', body: 'Hello' },
    { subject: 'Hi', body: 'Hello', templateId: 'tmpl_01h455vb4pex5vsknk084sn02q' },
  ])
    expect(bulkContactsInput.safeParse({ ...email, ...bad }).success).toBe(false);
  const text = { action: 'send_sms', selection };
  expect(bulkContactsInput.safeParse({ ...text, message: 'x'.repeat(1600) }).success).toBe(true);
  expect(bulkContactsInput.safeParse({ ...text, message: 'x'.repeat(1601) }).success).toBe(false);
});

it('drips in batches of 1 to 10,000, at most thirty days apart, as GoHighLevel allows', () => {
  const body = (drip: unknown) => ({
    action: 'send_sms',
    message: 'Hi',
    delivery: { drip },
    selection,
  });
  expect(
    bulkContactsInput.safeParse(body({ batchSize: 10_000, intervalMinutes: 43_200 })).success,
  ).toBe(true);
  for (const bad of [
    { batchSize: 0, intervalMinutes: 5 },
    { batchSize: 10_001, intervalMinutes: 5 },
    { batchSize: 10, intervalMinutes: 0 },
    { batchSize: 10, intervalMinutes: 43_201 },
    { batchSize: 10 },
  ])
    expect(bulkContactsInput.safeParse(body(bad)).success).toBe(false);
  // An export and a move to the trash run as soon as they can.
  expect(bulkContactsInput.safeParse({ action: 'trash', delivery: {}, selection }).success).toBe(
    false,
  );
});

it('turns do not disturb on or off for every channel or chosen ones, saying why', () => {
  const dnd = { action: 'set_dnd', dnd: 'on', reason: 'Asked us at the fair.', selection };
  expect(bulkContactsInput.safeParse({ ...dnd, channels: 'all' }).success).toBe(true);
  expect(bulkContactsInput.safeParse({ ...dnd, channels: ['sms', 'email'] }).success).toBe(true);
  for (const bad of [
    { channels: [] },
    { channels: ['sms', 'sms'] },
    { channels: ['fax'] },
    { channels: 'all', reason: '' },
  ])
    expect(bulkContactsInput.safeParse({ ...dnd, ...bad }).success).toBe(false);
});

it('adds an opportunity in a pipeline, open unless won, without duplicates unless allowed', () => {
  const parsed = bulkContactsInput.parse({
    action: 'add_opportunity',
    pipelineId: 'pipe_01h455vb4pex5vsknk084sn02q',
    selection,
  });
  expect(parsed).toMatchObject({ status: 'open', allowDuplicates: false });
  for (const bad of [{ status: 'lost' }, { amount: '-1' }, { amount: '1.23456' }])
    expect(
      bulkContactsInput.safeParse({
        action: 'add_opportunity',
        pipelineId: 'pipe_01h455vb4pex5vsknk084sn02q',
        selection,
        ...bad,
      }).success,
    ).toBe(false);
});
