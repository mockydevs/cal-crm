import { expect, it } from 'vitest';

import {
  botChallenge,
  botChallengeRequest,
  botProof,
  botProtection,
  calendar,
  formDefinition,
  publicBookingInput,
  publicCalendarPage,
  publicForm,
  publicFormSubmissionInput,
  DEFAULT_FORM_DEFINITION,
  FORM_LIMITS,
} from './index.js';

const TOKEN = `1793000000000.${'A'.repeat(43)}`;
const challenge = {
  parameters: {
    algorithm: 'PBKDF2/SHA-256',
    nonce: 'ab'.repeat(16),
    salt: 'cd'.repeat(16),
    cost: 1000,
    keyLength: 32,
    keyPrefix: 'ef'.repeat(16),
    keySignature: '01'.repeat(32),
    expiresAt: 1_793_003_600,
    data: { render: 'A'.repeat(43) },
  },
  signature: '02'.repeat(32),
};
const proof = {
  kind: 'altcha',
  challenge,
  solution: { counter: 4321, derivedKey: 'ef'.repeat(32), time: 812.5 },
};

it('is off or ALTCHA, and nothing else yet', () => {
  expect(botProtection.options).toEqual(['off', 'altcha']);
  expect(botProtection.safeParse('turnstile').success).toBe(false);
});

it('carries ALTCHA v2 challenges and proofs as altcha-lib makes them, and nothing more', () => {
  expect(botChallenge.parse({ kind: 'altcha', challenge })).toEqual({ kind: 'altcha', challenge });
  expect(botProof.parse(proof)).toEqual(proof);
  const parameters = (change: Record<string, unknown>) => ({
    ...proof,
    challenge: { ...challenge, parameters: { ...challenge.parameters, ...change } },
  });
  for (const bad of [
    { ...proof, kind: 'turnstile' },
    parameters({ nonce: 'XYZ' }),
    parameters({ keyPrefix: 'EF' }),
    parameters({ cost: 0 }),
    parameters({ data: { render: 'A', more: 'x' } }),
    parameters({ extra: 1 }),
    { ...proof, solution: { counter: -1, derivedKey: 'ef' } },
    { ...proof, solution: { counter: 2 ** 32, derivedKey: 'ef' } },
    { ...proof, solution: { counter: 1, derivedKey: 'e' } },
    { ...proof, challenge: { ...challenge, signature: 'zz' } },
  ])
    expect(botProof.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  expect(botChallengeRequest.safeParse({ renderToken: TOKEN }).success).toBe(true);
  expect(botChallengeRequest.safeParse({ renderToken: 'nope' }).success).toBe(false);
});

it('is left out of a form until it is switched on, and a calendar starts with it off', () => {
  expect(formDefinition.parse(DEFAULT_FORM_DEFINITION)).not.toHaveProperty('botProtection');
  expect(
    formDefinition.parse({ ...DEFAULT_FORM_DEFINITION, botProtection: 'altcha' }).botProtection,
  ).toBe('altcha');
  expect(calendar.shape.botProtection.parse(undefined)).toBe('off');
});

it('lets a page say it asks for a proof, and a submission or booking send one', () => {
  const page = {
    name: 'Consultation',
    description: '',
    timezone: 'America/New_York',
    slotMinutes: 30,
    durations: [30],
    notificationWording: null,
    renderToken: TOKEN,
    appearance: {
      style: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff',
      buttonText: '',
      logoUrl: null,
      coverUrl: null,
    },
  };
  expect(publicCalendarPage.parse({ ...page, botProtection: 'altcha' }).botProtection).toBe(
    'altcha',
  );
  expect(publicCalendarPage.parse(page)).not.toHaveProperty('botProtection');
  const booking = {
    bookingRequestId: '0198de17-876e-7000-aac7-9bc8ac22900d',
    startsAt: '2026-11-03T15:00:00Z',
    contact: { email: 'maya@example.test' },
    contactTimezone: 'America/New_York',
    renderToken: TOKEN,
  };
  expect(publicBookingInput.parse({ ...booking, botProof: proof }).botProof).toEqual(proof);
  expect(publicBookingInput.safeParse({ ...booking, botProof: { kind: 'altcha' } }).success).toBe(
    false,
  );
  const shown = publicForm.parse({
    title: '',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thanks.',
    fields: [],
    consents: [],
    renderToken: TOKEN,
    botProtection: 'altcha',
    textLength: FORM_LIMITS.textLength,
    longTextLength: FORM_LIMITS.longTextLength,
  });
  expect(shown.botProtection).toBe('altcha');
  expect(
    publicFormSubmissionInput.parse({
      clientSubmissionId: '0198de17-876e-7000-aac7-9bc8ac22900d',
      renderToken: TOKEN,
      values: {},
      consents: {},
      botProof: proof,
    }).botProof,
  ).toEqual(proof);
});
