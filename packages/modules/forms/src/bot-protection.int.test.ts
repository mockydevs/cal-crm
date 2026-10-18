// A form's bot protection against Postgres: off by default; when on, the visitor's
// browser is given an ALTCHA challenge bound to the showing it holds, and a submission is
// stored only with a proof solved for that showing. It is checked after the form's own
// limits and the render token, never instead of them.
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_FORM_DEFINITION,
  publicForm,
  type BotProof,
  type PublicFormSubmissionInput,
} from '@repo/contracts';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { beforeAll, expect, it } from 'vitest';

import { formSuite, SECRET, WEBSITE } from '../test/form-fixtures.js';
import { createAltchaBotChallenge, toAltchaChallenge } from './bot-challenge.js';
import { createPublicFormHandlers, type PublicFormHandlers } from './index.js';

const suite = formSuite();
const { fixture, published, stored, visitor } = suite;
let handlers: PublicFormHandlers;
beforeAll(() => {
  handlers = createPublicFormHandlers({
    db: suite.db,
    secret: SECRET,
    now: suite.now,
    // ALTCHA itself, with little work: the policy's own work is in bot-challenge.test.
    bot: createAltchaBotChallenge(SECRET, { cost: 1, counter: { min: 1, max: 20 } }),
  });
});

const guarded = { ...DEFAULT_FORM_DEFINITION, botProtection: 'altcha' as const };

async function shown(publicKey: string) {
  const admission = await handlers.admit(publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Expected the form to admit the website.');
  const answer = await handlers.form(admission, visitor());
  if (answer.outcome !== 'ok') throw new Error(`Expected the form: ${answer.outcome}.`);
  return { admission, form: publicForm.parse(answer.form) };
}

async function solved(
  admission: Awaited<ReturnType<typeof shown>>['admission'],
  renderToken: string,
): Promise<BotProof> {
  const answer = await handlers.challenge(admission, { renderToken }, visitor());
  if (answer.outcome !== 'ok') throw new Error(`Expected a challenge: ${answer.outcome}.`);
  const { challenge } = answer.challenge;
  const solution = await solveChallenge({ challenge: toAltchaChallenge(challenge), deriveKey });
  if (solution === null) throw new Error('Expected a solution.');
  return { kind: 'altcha', challenge, solution };
}

const input = (
  renderToken: string,
  email: string,
  botProof?: BotProof,
): PublicFormSubmissionInput => ({
  clientSubmissionId: randomUUID(),
  renderToken,
  values: { email },
  consents: {},
  trap: '',
  ...(botProof === undefined ? {} : { botProof }),
});

it('is off by default: the form names none, gives no challenge and stores without a proof', async () => {
  const f = await fixture();
  const form = await published(f);
  const { admission, form: view } = await shown(form.publicKey);
  expect(view).not.toHaveProperty('botProtection');
  expect(await handlers.challenge(admission, { renderToken: view.renderToken }, visitor())).toEqual(
    { outcome: 'unavailable' },
  );
  suite.wait(3000);
  expect(
    await handlers.submit(admission, input(view.renderToken, 'open@example.test'), visitor()),
  ).toEqual({ outcome: 'ok', receipt: { status: 'received' } });
});

it('when on, stores a submission only with a proof solved for that showing, once', async () => {
  const f = await fixture();
  const form = await published(f, guarded);
  const { admission, form: view } = await shown(form.publicKey);
  expect(view.botProtection).toBe('altcha');
  // The challenge is given at once, before a person's pause, and bound to the showing.
  const proof = await solved(admission, view.renderToken);
  expect(proof.challenge.parameters.data).toEqual({ render: view.renderToken.slice(14) });
  suite.wait(3000);
  // Without a proof, with a wrong one, or with one for another showing: shown again.
  const other = await shown(form.publicKey);
  const elsewhere = await solved(other.admission, other.form.renderToken);
  for (const botProof of [
    undefined,
    { ...proof, solution: { ...proof.solution, derivedKey: '00'.repeat(32) } },
    elsewhere,
  ])
    expect(
      await handlers.submit(
        admission,
        input(view.renderToken, 'guarded@example.test', botProof),
        visitor(),
      ),
    ).toEqual({ outcome: 'stale' });
  expect(await stored(f)).toMatchObject({ submissions: 0, contacts: 0 });
  expect(
    await handlers.submit(
      admission,
      input(view.renderToken, 'guarded@example.test', proof),
      visitor(),
    ),
  ).toEqual({ outcome: 'ok', receipt: { status: 'received' } });
  // The solved challenge is spent with its showing.
  expect(
    await handlers.submit(
      admission,
      input(view.renderToken, 'again@example.test', proof),
      visitor(),
    ),
  ).toEqual({ outcome: 'stale' });
  expect(await stored(f)).toMatchObject({ submissions: 1, contacts: 1 });
});

it('gives no challenge for a token of another source, form or install', async () => {
  const f = await fixture();
  const form = await published(f, guarded);
  const { admission, form: view } = await shown(form.publicKey);
  expect(
    await handlers.challenge(
      admission,
      { renderToken: view.renderToken },
      visitor({ ipAddress: '198.51.100.20' }),
    ),
  ).toEqual({ outcome: 'stale' });
  expect(
    await handlers.challenge(
      admission,
      { renderToken: `1790000000000.${'A'.repeat(43)}` },
      visitor(),
    ),
  ).toEqual({ outcome: 'stale' });
});

it('keeps the quota first: a limited source is told to wait before any proof is read', async () => {
  const f = await fixture();
  const form = await published(f, guarded);
  const limited = createPublicFormHandlers({
    db: suite.db,
    secret: SECRET,
    now: suite.now,
    bot: createAltchaBotChallenge(SECRET, { cost: 1, counter: { min: 1, max: 20 } }),
    limits: { sourcePerHour: 0 },
  });
  const admission = await limited.admit(form.publicKey, WEBSITE);
  if (admission === undefined) throw new Error('Expected an admission.');
  const answer = await limited.form(admission, visitor());
  if (answer.outcome !== 'ok') throw new Error('Expected the form.');
  suite.wait(3000);
  expect(
    await limited.submit(admission, input(answer.form.renderToken, 'q@example.test'), visitor()),
  ).toMatchObject({ outcome: 'limited' });
});

it('lets the team rehearse it on a preview, which stores nothing', async () => {
  const f = await fixture();
  const form = await published(f, guarded);
  const { admission } = await shown(form.publicKey);
  const preview = { ...admission, preview: true as const };
  const draft = await handlers.form(preview, visitor());
  if (draft.outcome !== 'ok') throw new Error('Expected the draft.');
  expect(draft.form.botProtection).toBe('altcha');
  const answer = await handlers.challenge(
    preview,
    { renderToken: draft.form.renderToken },
    visitor(),
  );
  expect(answer.outcome).toBe('ok');
});
