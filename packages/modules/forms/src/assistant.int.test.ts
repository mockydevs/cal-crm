// What the forms module gives the in-app assistant, against Postgres: publishing as a
// proposable command, the draft an assistant may build, the websites it may not change, and
// a form's page checks. The proposals themselves are kept and applied by the AI module;
// composed with it and a scripted model, they are proven in apps/server.
import type { Invocation, Proposable, ProposalHooks, Services } from '@repo/commands';
import { allowEveryone, ApprovalRequiredError } from '@repo/commands';
import { form as formContract, type Form, type FormDefinitionInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
} from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { formSuite, PUBLIC_URL, WEBSITE } from '../test/form-fixtures.js';
import { formProposables, readFormChecks } from './index.js';

const suite = formSuite();
const { fixture, admin } = suite;
let database: TestDatabase;
let services: Services;
beforeAll(() => {
  database = suite.database;
  services = { db: suite.db, authorize: allowEveryone };
});
type Fixture = Awaited<ReturnType<typeof fixture>>;

const create = async (
  f: Fixture,
  name = 'Wedding enquiry',
  invocation?: Invocation,
): Promise<Form> =>
  formContract.parse(await admin(f, 'createForm', { body: { name } }, invocation));
const read = async (f: Fixture, id: string): Promise<Form> =>
  formContract.parse(await admin(f, 'getForm', { params: { id } }));
const save = async (
  f: Fixture,
  current: Form,
  change: { name?: string; definition?: FormDefinitionInput; allowedOrigins?: readonly string[] },
  invocation?: Invocation,
): Promise<Form> =>
  formContract.parse(
    await admin(
      f,
      'updateForm',
      {
        params: { id: current.id },
        body: {
          name: change.name ?? current.name,
          definition: change.definition ?? current.definition,
          allowedOrigins: change.allowedOrigins ?? current.allowedOrigins,
          revision: current.revision,
        },
      },
      invocation,
    ),
  );
/** A refusal as a rejection, whether the route threw before or after it returned a promise. */
const attempt = <T>(work: () => Promise<T>): Promise<T> => Promise.resolve().then(work);

/** The in-app assistant working for the fixture's manager, with these permissions. */
const copilot = (f: Fixture, permissions: Invocation['permissions'] = 'all'): Invocation => {
  const { actorId: _person, ...context } = f.manager.context;
  return { context: { ...context, actorKind: 'ai_agent' }, permissions, agent: 'copilot' };
};
const proposable = (kind: string): Proposable => {
  const found = formProposables(PUBLIC_URL).find((each) => each.kind === kind);
  if (found === undefined) throw new Error(`Nothing is proposed as ${kind}.`);
  return found;
};
const inForm = <Answer>(f: Fixture, work: Parameters<typeof withTenant<Answer>>[2]) =>
  withTenant(suite.db, f.manager.context, work);

/** Runs a proposable's command as the store would, and gives back what it handed the store. */
async function run(
  kind: string,
  input: unknown,
  invocation: Invocation,
  begin: ProposalHooks['begin'] = () => Promise.resolve('run'),
) {
  let done: Parameters<ProposalHooks['finish']>[1] | undefined;
  const ran = await proposable(kind).run(services, input, invocation, {
    proposal: { id: '01890a5d-ac96-774b-bcce-b302099a8057', agent: 'copilot' },
    begin,
    finish: (_trx, outcome) => {
      done = outcome;
      return Promise.resolve();
    },
  });
  return { ran, done };
}

describe('what an assistant may build', () => {
  it('makes and edits a draft as the in-app assistant, held to the person’s permission and the business’s rule', async () => {
    const f = await fixture();
    const made = await create(f, 'Built by the assistant', copilot(f));
    expect(made).toMatchObject({ name: 'Built by the assistant', status: 'draft' });
    const saved = await save(
      f,
      made,
      {
        definition: {
          ...made.definition,
          fields: [
            ...made.definition.fields,
            { key: 'campaign', type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
          ],
        },
      },
      copilot(f),
    );
    expect(saved.definition.fields.at(-1)).toMatchObject({ key: 'campaign', type: 'hidden' });
    const events = await database.withTenant(f.business.context, (sql) =>
      sql.query<{ type: string; actor_kind: string }>(
        "select type, actor_kind from events.events where type like 'form.%' order by recorded_at, id",
      ),
    );
    expect(events).toEqual([
      { type: 'form.created', actor_kind: 'ai_agent' },
      { type: 'form.updated', actor_kind: 'ai_agent' },
    ]);

    // Without the person's permission it is refused like anyone, naming it.
    await expect(attempt(() => create(f, 'No role', copilot(f, new Set())))).rejects.toMatchObject({
      permission: 'forms.manage',
    });
    // Any other assistant builds nothing, and the business can hold this one to asking.
    await expect(
      attempt(() => create(f, 'By the inbox agent', { ...copilot(f), agent: 'inbox' })),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into ai.autonomy_rules (business_id, agent, action, level)
         values (app.business_id(), 'copilot', 'build_draft', 'ask')`,
      ),
    );
    await expect(attempt(() => create(f, 'Held', copilot(f)))).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
  });

  it('never lets an assistant change the websites that may show a form, and never publish by itself', async () => {
    const f = await fixture();
    const made = await save(f, await create(f), { allowedOrigins: [WEBSITE] });
    for (const allowedOrigins of [
      [],
      [WEBSITE, 'https://evil.example'],
      ['https://evil.example'],
    ]) {
      const refused = attempt(() => save(f, made, { allowedOrigins }, copilot(f)));
      await expect(refused).rejects.toBeInstanceOf(ForbiddenError);
      await expect(refused).rejects.toThrow(
        'An assistant cannot change the websites that may show a form.',
      );
    }
    // Saving with the websites the form has is a change to the draft, which it may make.
    const renamed = await save(f, made, { name: 'Renamed', allowedOrigins: [WEBSITE] }, copilot(f));
    expect(renamed).toMatchObject({ name: 'Renamed', allowedOrigins: [WEBSITE] });
    // A person still changes them.
    expect((await save(f, renamed, { allowedOrigins: [] })).allowedOrigins).toEqual([]);

    // Publishing starts at asking: the assistant runs it only where the business said act.
    const current = await read(f, made.id);
    const publish = () =>
      admin(
        f,
        'publishForm',
        { params: { id: current.id }, body: { revision: current.revision } },
        copilot(f),
      );
    await expect(attempt(publish)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect((await read(f, made.id)).status).toBe('draft');
    // Taking a form down is not delegated at all.
    await expect(
      attempt(() =>
        admin(
          f,
          'archiveForm',
          { params: { id: current.id }, body: { revision: current.revision } },
          copilot(f),
        ),
      ),
    ).rejects.toMatchObject({ reason: 'not_delegable' });
  });
});

describe('publishing as a proposal', () => {
  it('is about the form, made on the form as it stands, and shows what would go live', async () => {
    const f = await fixture();
    const made = await create(f);
    const input = { id: made.id, revision: made.revision };
    const publish = proposable('form_publish');
    expect(publish).toMatchObject({
      commandName: 'forms.publish',
      permission: 'forms.manage',
      action: 'publish',
      agents: ['copilot'],
      changeable: false,
    });
    publish.check(input);
    expect(() => {
      publish.check({ id: made.id });
    }).toThrow(ValidationError);
    expect(await inForm(f, (trx) => publish.subject(trx, input))).toEqual({
      formId: parsePublicId('form', made.id),
    });
    expect(await inForm(f, (trx) => publish.revision(trx, input))).toBe(made.revision);
    expect(await inForm(f, (trx) => publish.present(trx, input, f.manager))).toEqual({
      kind: 'form_publish',
      formId: made.id,
      name: 'Wedding enquiry',
      questions: 2,
      consents: 0,
      republish: false,
    });
    // A save moves the fingerprint: a proposal made before it is stale.
    const saved = await save(f, made, {
      definition: {
        ...made.definition,
        fields: [
          ...made.definition.fields,
          { key: 'intro', type: 'content', label: 'Intro', text: 'Tell us about your day.' },
        ],
        consents: [{ key: 'news', channel: 'email', wording: 'Send me news.' }],
      },
    });
    expect(await inForm(f, (trx) => publish.revision(trx, input))).toBe(saved.revision);
    // A block of text asks nothing: it is not counted as a question.
    expect(await inForm(f, (trx) => publish.present(trx, input, f.manager))).toMatchObject({
      questions: 2,
      consents: 1,
    });
    // A form that is not there, or of another business, is not found.
    const elsewhere = await fixture();
    const there = (reading: 'subject' | 'revision'): Promise<unknown> =>
      withTenant(suite.db, elsewhere.manager.context, (trx): Promise<unknown> =>
        reading === 'subject' ? publish.subject(trx, input) : publish.revision(trx, input),
      );
    for (const reading of ['subject', 'revision'] as const)
      await expect(there(reading)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inForm(f, (trx) => publish.subject(trx, { id: 'form_nothing', revision: made.revision })),
    ).rejects.toThrow();
  });

  it('is not shown for a draft that cannot be published: its problems are the answer', async () => {
    const f = await fixture();
    const made = await create(f);
    const broken = await save(f, made, {
      definition: { ...made.definition, fields: made.definition.fields.slice(0, 1) },
    });
    const presenting = inForm(f, (trx) =>
      proposable('form_publish').present(
        trx,
        { id: broken.id, revision: broken.revision },
        f.manager,
      ),
    );
    await expect(presenting).rejects.toBeInstanceOf(ValidationError);
    await expect(presenting).rejects.toMatchObject({ issues: [{ code: 'no_identity' }] });
  });

  it('publishes as whoever applies it, answers with the link and the embed line, and is undone back to a draft', async () => {
    const f = await fixture();
    const made = await create(f);
    const { ran, done } = await run(
      'form_publish',
      { id: made.id, revision: made.revision },
      f.manager,
    );
    const live = await read(f, made.id);
    expect(ran).toBe(true);
    expect(live.status).toBe('published');
    expect(done).toMatchObject({
      result: {
        formId: made.id,
        hostedUrl: `${PUBLIC_URL}/f/${made.publicKey}`,
        embedSnippet: made.embedSnippet,
        publicKey: made.publicKey,
      },
      undo: { kind: 'form_unpublish', input: { id: made.id, revision: live.revision } },
    });
    expect(done?.eventIds).toHaveLength(1);

    // The way back is the form's own unpublish, which is never proposed by itself.
    const back = proposable('form_unpublish');
    expect(back).toMatchObject({
      commandName: 'forms.unpublish',
      action: 'publish',
      agents: [],
      changeable: false,
    });
    const undoing = { id: made.id, revision: live.revision };
    expect(await inForm(f, (trx) => back.subject(trx, undoing))).toEqual({
      formId: parsePublicId('form', made.id),
    });
    expect(await inForm(f, (trx) => back.revision(trx, undoing))).toBe(live.revision);
    expect(await inForm(f, (trx) => back.present(trx, undoing, f.manager))).toEqual({
      kind: 'form_unpublish',
      formId: made.id,
      name: 'Wedding enquiry',
    });
    const undone = await run('form_unpublish', undoing, f.manager);
    expect(undone.done).toMatchObject({
      result: { formId: made.id },
      undo: { impossible: 'unpublished' },
    });
    expect(await read(f, made.id)).toMatchObject({ status: 'draft', publishedDefinition: null });
  });

  it('cannot be undone for a form that was live before: there is no draft to go back to', async () => {
    const f = await fixture();
    const first = await suite.published(f);
    const changed = await save(f, first, { name: 'Changed while live' });
    const { done } = await run(
      'form_publish',
      { id: changed.id, revision: changed.revision },
      f.manager,
    );
    expect(done?.undo).toEqual({ impossible: 'published_before' });
    expect(
      await inForm(f, async (trx) =>
        proposable('form_publish').present(
          trx,
          { id: changed.id, revision: (await read(f, changed.id)).revision },
          f.manager,
        ),
      ),
    ).toMatchObject({ republish: true });
  });

  it('runs nothing when the store says it was already done, or refuses, or the role lacks the permission', async () => {
    const f = await fixture();
    const made = await create(f);
    const input = { id: made.id, revision: made.revision };
    expect((await run('form_publish', input, f.manager, () => Promise.resolve('repeat'))).ran).toBe(
      false,
    );
    await expect(
      run('form_publish', input, f.manager, () => Promise.reject(new ConflictError('Stale.'))),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      run('form_publish', input, { ...f.manager, permissions: new Set(['assistant.use']) }),
    ).rejects.toMatchObject({ permission: 'forms.manage' });
    // The assistant itself applies it only where the business's rule for publishing says act.
    await expect(run('form_publish', input, copilot(f))).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    await expect(run('form_unpublish', input, copilot(f))).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect((await read(f, made.id)).status).toBe('draft');
  });
});

describe('a form’s page checks', () => {
  it('are its own problems first, then what it usually has and lacks, with its name', async () => {
    const f = await fixture();
    const made = await create(f);
    const checks = (listeners?: number) =>
      inForm(f, (trx) =>
        readFormChecks(trx, f.manager, made.id, {
          publicUrl: PUBLIC_URL,
          ...(listeners === undefined
            ? {}
            : {
                listeners: (_trx, formId) => {
                  expect(formId).toBe(made.id);
                  return Promise.resolve(listeners);
                },
              }),
        }),
      );
    const fresh = await checks(0);
    expect(fresh).toMatchObject({ id: made.id, name: 'Wedding enquiry' });
    expect(fresh.checks.map((check) => [check.severity, check.code])).toEqual([
      ['suggestion', 'no_consent_box'],
      ['suggestion', 'no_allowed_website'],
      ['suggestion', 'no_workflow'],
      ['suggestion', 'no_campaign_field'],
    ]);
    // With a workflow listening, and with nobody to say, nothing is said of workflows.
    for (const listeners of [2, undefined])
      expect((await checks(listeners)).checks.map((check) => check.code)).not.toContain(
        'no_workflow',
      );

    await save(f, made, {
      definition: { ...made.definition, fields: made.definition.fields.slice(0, 1) },
      allowedOrigins: [WEBSITE],
    });
    expect((await checks(1)).checks.map((check) => [check.severity, check.code])).toEqual([
      ['blocker', 'no_identity'],
      ['suggestion', 'no_consent_box'],
      ['suggestion', 'no_campaign_field'],
    ]);
    // Anyone in the business may read them; another business finds no form.
    const viewer = { ...f.manager, permissions: new Set<never>() };
    expect(
      (await inForm(f, (trx) => readFormChecks(trx, viewer, made.id, { publicUrl: PUBLIC_URL })))
        .name,
    ).toBe('Wedding enquiry');
    const elsewhere = await fixture();
    await expect(
      withTenant(suite.db, elsewhere.manager.context, (trx) =>
        readFormChecks(trx, elsewhere.manager, made.id, { publicUrl: PUBLIC_URL }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
