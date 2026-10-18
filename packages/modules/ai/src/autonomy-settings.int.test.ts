// How much an assistant does on its own, as a business sets it: read by anyone in the
// business, changed with `ai.manage`, for the business or for one contact, and never across
// businesses. What the command layer then does with a rule is proven where it reads one
// (packages/commands, and proposals.int.test.ts here).
import { getAutonomy, getConversationAssistant, setAutonomy } from '@repo/contracts';
import { ForbiddenError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startAssistantWorld, type AssistantWorld } from '../test/assistant-world.js';
import type { Person } from '../test/settings-world.js';

let world: AssistantWorld;
beforeAll(async () => {
  world = await startAssistantWorld(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

const send = { agent: 'inbox', action: 'send_message' } as const;
const read = (person: Pick<Person, 'invocation'>, contactId?: string) =>
  world.ask(getAutonomy, person, { query: contactId === undefined ? {} : { contactId } });
const set = (person: Pick<Person, 'invocation'>, body: Record<string, unknown>) =>
  world.ask(setAutonomy, person, { body: { ...send, ...body } });
const rules = (person: Person) =>
  world.database.withTenant(person.context, (sql) =>
    sql.query<{ contact_id: string | null; level: string; updated_by_id: string | null }>(
      'select contact_id, level, updated_by_id from ai.autonomy_rules order by contact_id nulls first',
    ),
  );
const events = (person: Person) =>
  world.database.as('crm_owner', (sql) =>
    sql.query<{ type: string; subject_kind: string; payload: unknown }>(
      `select type, subject_kind, payload from events.events
       where business_id = $1 order by recorded_at, id`,
      [person.context.businessId],
    ),
  );

/**
 * The extraction assistant's two kinds of action and the in-app assistant's two. No test
 * here sets a rule for any, so each is listed where it starts.
 */
const untouched = [
  ...(['update_field', 'remember_fact'] as const).map((action) => ({
    agent: 'extraction',
    action,
    level: 'ask',
    source: 'default',
    businessLevel: 'ask',
  })),
  // The in-app assistant: it builds drafts without asking, and asks to publish.
  {
    agent: 'copilot',
    action: 'build_draft',
    level: 'act',
    source: 'default',
    businessLevel: 'act',
  },
  { agent: 'copilot', action: 'publish', level: 'ask', source: 'default', businessLevel: 'ask' },
];

describe('reading', () => {
  it('starts every assistant at asking first, for the business and for a contact', async () => {
    const dana = await world.admin();
    const talk = await world.conversation(dana);
    const expected = { ...send, level: 'ask', source: 'default', businessLevel: 'ask' };
    expect(await read(dana)).toEqual({ canChange: true, items: [expected, ...untouched] });
    expect(await read(dana, toPublicId('contact', talk.contactId))).toEqual({
      canChange: true,
      items: [expected, ...untouched],
    });
    expect(await rules(dana)).toEqual([]);
  });

  it('is open to anyone in the business, who is told whether changing it is theirs', async () => {
    const dana = await world.admin();
    await set(dana, { level: 'suggest' });
    const viewer = world.limited(dana, []);
    expect(await read(viewer)).toEqual({
      canChange: false,
      items: [
        { ...send, level: 'suggest', source: 'business', businessLevel: 'suggest' },
        ...untouched,
      ],
    });
    expect((await read(world.limited(dana, ['ai.manage']))).canChange).toBe(true);
  });
});

describe('changing', () => {
  it('sets the business’s level, records who did, and says what changed', async () => {
    const dana = await world.admin();
    expect(await set(dana, { level: 'act' })).toEqual({
      ...send,
      level: 'act',
      source: 'business',
      businessLevel: 'act',
    });
    expect(await rules(dana)).toEqual([
      { contact_id: null, level: 'act', updated_by_id: dana.userId },
    ]);
    expect(await events(dana)).toEqual([
      {
        type: 'autonomy.changed',
        subject_kind: 'business',
        payload: { ...send, contactId: null, from: 'ask', to: 'act' },
      },
    ]);
    // The same level again is one rule still, and nothing new happened.
    await set(dana, { level: 'act' });
    expect(await rules(dana)).toHaveLength(1);
    expect(await events(dana)).toHaveLength(1);
  });

  it('sets one contact’s level beside the business’s, on that contact’s timeline', async () => {
    const dana = await world.admin();
    const maya = await world.conversation(dana);
    const ken = await world.conversation(dana);
    const mayaId = toPublicId('contact', maya.contactId);
    await set(dana, { level: 'suggest' });
    expect(await set(dana, { contactId: mayaId, level: 'act' })).toEqual({
      ...send,
      level: 'act',
      source: 'contact',
      businessLevel: 'suggest',
    });
    expect((await read(dana, mayaId)).items).toEqual([
      { ...send, level: 'act', source: 'contact', businessLevel: 'suggest' },
      ...untouched,
    ]);
    // Ken follows the business, and so does the business itself.
    expect((await read(dana, toPublicId('contact', ken.contactId))).items).toEqual([
      { ...send, level: 'suggest', source: 'business', businessLevel: 'suggest' },
      ...untouched,
    ]);
    expect((await read(dana)).items).toEqual([
      { ...send, level: 'suggest', source: 'business', businessLevel: 'suggest' },
      ...untouched,
    ]);
    // The Inbox shows Maya's own level in her conversation.
    expect(
      (await world.ask(getConversationAssistant, dana, { params: { id: maya.publicId } })).autonomy,
    ).toEqual({
      ...send,
      level: 'act',
      source: 'contact',
      businessLevel: 'suggest',
      canChange: true,
    });
    expect((await events(dana)).at(-1)).toEqual({
      type: 'autonomy.changed',
      subject_kind: 'contact',
      payload: { ...send, contactId: mayaId, from: 'suggest', to: 'act' },
    });
    const timeline = await world.database.withTenant(dana.context, (sql) =>
      sql.query('select event_type from crm.timeline_entries where record_id = $1', [
        maya.contactId,
      ]),
    );
    expect(timeline).toEqual([{ event_type: 'autonomy.changed' }]);
  });

  it('removes a rule: the contact follows the business again, the business the starting level', async () => {
    const dana = await world.admin();
    const maya = await world.conversation(dana);
    const mayaId = toPublicId('contact', maya.contactId);
    await set(dana, { level: 'act' });
    await set(dana, { contactId: mayaId, level: 'suggest' });
    expect(await set(dana, { contactId: mayaId, level: null })).toEqual({
      ...send,
      level: 'act',
      source: 'business',
      businessLevel: 'act',
    });
    expect(await set(dana, { level: null })).toEqual({
      ...send,
      level: 'ask',
      source: 'default',
      businessLevel: 'ask',
    });
    expect(await rules(dana)).toEqual([]);
    // Removing what is not there changes nothing and says nothing.
    const before = (await events(dana)).length;
    await set(dana, { level: null });
    expect(await events(dana)).toHaveLength(before);
  });

  it('keeps a rule for another kind of action apart', async () => {
    const dana = await world.admin();
    await set(dana, { level: 'act' });
    expect(await set(dana, { action: 'update_conversation', level: 'suggest' })).toMatchObject({
      action: 'update_conversation',
      level: 'suggest',
    });
    expect((await read(dana)).items).toEqual([
      { ...send, level: 'act', source: 'business', businessLevel: 'act' },
      ...untouched,
    ]);
  });

  it('needs ai.manage: someone who works the inbox cannot let the assistant act', async () => {
    const dana = await world.admin();
    const member = world.limited(dana, ['conversations.reply', 'conversations.manage']);
    const attempt = set(member, { level: 'act' });
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ permission: 'ai.manage' });
    expect(await rules(dana)).toEqual([]);
    expect((await set(world.limited(dana, ['ai.manage']), { level: 'act' })).level).toBe('act');
  });

  it('refuses a level, an assistant or an action it does not know', async () => {
    const dana = await world.admin();
    for (const body of [
      { level: 'always' },
      { agent: 'robot', level: 'act' },
      { action: 'delete_everything', level: 'act' },
      {},
    ])
      await expect(set(dana, body)).rejects.toBeInstanceOf(ValidationError);
    expect(await rules(dana)).toEqual([]);
  });
});

describe('another business', () => {
  it('cannot read or set a level for our contact, and its own rules are its own', async () => {
    const ours = await world.admin();
    const maya = await world.conversation(ours);
    const mayaId = toPublicId('contact', maya.contactId);
    await set(ours, { level: 'act' });
    for (const theirs of [await world.admin(), await world.admin(ours.context.agencyId)]) {
      await expect(read(theirs, mayaId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(set(theirs, { contactId: mayaId, level: 'act' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // Their business starts where every business starts, whatever ours has set.
      expect((await read(theirs)).items).toEqual([
        { ...send, level: 'ask', source: 'default', businessLevel: 'ask' },
        ...untouched,
      ]);
      await set(theirs, { level: 'suggest' });
    }
    expect((await read(ours)).items).toEqual([
      { ...send, level: 'act', source: 'business', businessLevel: 'act' },
      ...untouched,
    ]);
    expect(await rules(ours)).toEqual([
      { contact_id: null, level: 'act', updated_by_id: ours.userId },
    ]);
  });

  it('has no level to read or set at the agency, outside any business', async () => {
    const dana = await world.admin();
    const { businessId: _none, ...atTheAgency } = dana.context;
    const staff = { invocation: { ...dana.invocation, context: atTheAgency } };
    await expect(read(staff)).rejects.toBeInstanceOf(ValidationError);
    await expect(set(staff, { level: 'act' })).rejects.toBeInstanceOf(ValidationError);
  });
});
