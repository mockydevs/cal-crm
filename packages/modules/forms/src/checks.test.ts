import { DEFAULT_FORM_DEFINITION, type Form, type FormDefinition } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { formChecks } from './checks.js';

const id = toPublicId('form', '01890a5d-ac96-774b-bcce-b302099a8057');

/** A form with everything a form usually has, so it is suggested nothing. */
const complete: FormDefinition = {
  ...DEFAULT_FORM_DEFINITION,
  fields: [
    ...DEFAULT_FORM_DEFINITION.fields,
    {
      key: 'campaign',
      type: 'hidden',
      label: 'Campaign',
      helpText: '',
      required: false,
      options: [],
      target: { kind: 'none' },
      parameter: 'utm_campaign',
    },
  ],
  consents: [{ key: 'news', channel: 'email', wording: 'Send me news.', required: false }],
  notify: { mode: 'managers' },
};

const form = (
  changes: Partial<
    Pick<Form, 'status' | 'definition' | 'allowedOrigins' | 'problems' | 'hasUnpublishedChanges'>
  > = {},
) => ({
  id,
  status: 'draft' as const,
  definition: complete,
  allowedOrigins: ['https://www.example.com'],
  problems: [],
  hasUnpublishedChanges: false,
  ...changes,
});

const codes = (checks: ReturnType<typeof formChecks>): string[] => checks.map((each) => each.code);

describe('formChecks', () => {
  it('finds nothing on a form that has it all and a workflow listening', () => {
    expect(formChecks(form(), 1)).toEqual([]);
  });

  it('suggests each thing a new form lacks, in one order, each with where to fix it', () => {
    const checks = formChecks(form({ definition: DEFAULT_FORM_DEFINITION, allowedOrigins: [] }), 0);
    expect(codes(checks)).toEqual([
      'no_consent_box',
      'no_allowed_website',
      'no_workflow',
      'no_campaign_field',
    ]);
    expect(checks.every((check) => check.severity === 'suggestion')).toBe(true);
    expect(checks.map((check) => check.target)).toEqual([
      { kind: 'form', id, section: 'consent', path: '/consents' },
      { kind: 'form', id, section: 'websites', path: '/allowedOrigins' },
      { kind: 'automations', id: null, section: null, path: null },
      { kind: 'form', id, section: 'questions', path: '/fields' },
    ]);
    for (const check of checks) expect(check.message).toMatch(/^[A-Z].*\.$/);
  });

  it('says when nobody is told, and when a live form has changes waiting', () => {
    expect(
      codes(
        formChecks(
          form({
            status: 'published',
            hasUnpublishedChanges: true,
            definition: { ...complete, notify: { mode: 'nobody' } },
          }),
          2,
        ),
      ),
    ).toEqual(['nobody_notified', 'unpublished_changes']);
    // A form that names nobody to tell falls back to its managers: that is not "nobody".
    expect(formChecks(form({ definition: { ...complete, notify: undefined } }), 1)).toEqual([]);
  });

  it('does not guess about workflows when nobody could say', () => {
    expect(codes(formChecks(form(), undefined))).toEqual([]);
  });

  it('puts what stops publishing first, as the form’s own problems word it', () => {
    const checks = formChecks(
      form({
        definition: DEFAULT_FORM_DEFINITION,
        problems: [
          { path: '/fields', code: 'no_identity', message: 'Ask for an email address.' },
          { path: '/consents/0/channel', code: 'no_address', message: 'Ask for a phone number.' },
          { path: '/notify/memberIds/0', code: 'unknown_member', message: 'Choose someone else.' },
          { path: '/contactActions/tagIds/0', code: 'unknown_tag', message: 'Choose another tag.' },
          { path: '/allowedOrigins/0', code: 'invalid_origin', message: 'Enter an address.' },
          { path: '/title', code: 'other', message: 'Something else.' },
        ],
      }),
      1,
    );
    expect(checks.slice(0, 6)).toEqual([
      {
        severity: 'blocker',
        code: 'no_identity',
        message: 'Ask for an email address.',
        target: { kind: 'form', id, section: 'questions', path: '/fields' },
      },
      {
        severity: 'blocker',
        code: 'no_address',
        message: 'Ask for a phone number.',
        target: { kind: 'form', id, section: 'consent', path: '/consents/0/channel' },
      },
      {
        severity: 'blocker',
        code: 'unknown_member',
        message: 'Choose someone else.',
        target: { kind: 'form', id, section: 'notify', path: '/notify/memberIds/0' },
      },
      {
        severity: 'blocker',
        code: 'unknown_tag',
        message: 'Choose another tag.',
        target: { kind: 'form', id, section: 'actions', path: '/contactActions/tagIds/0' },
      },
      {
        severity: 'blocker',
        code: 'invalid_origin',
        message: 'Enter an address.',
        target: { kind: 'form', id, section: 'websites', path: '/allowedOrigins/0' },
      },
      {
        severity: 'blocker',
        code: 'other',
        message: 'Something else.',
        target: { kind: 'form', id, section: null, path: '/title' },
      },
    ]);
    expect(codes(checks.slice(6))).toEqual(['no_consent_box', 'no_campaign_field']);
  });

  it('says nothing of an archived form', () => {
    expect(
      formChecks(
        form({
          status: 'archived',
          definition: DEFAULT_FORM_DEFINITION,
          allowedOrigins: [],
          problems: [{ path: '/fields', code: 'no_questions', message: 'Add a question.' }],
        }),
        0,
      ),
    ).toEqual([]);
  });
});
