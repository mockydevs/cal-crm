import { i18n } from '@lingui/core';
import type { TemplateWorkflowAction, WorkflowEmailStepStatistics } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  fileSizeWords,
  modeWords,
  otherUses,
  rangeStart,
  skipReasonWords,
  skipRows,
  statisticRows,
  workflowCount,
} from './rules';
import { folderPath, namedTemplate, templateItems } from './template-picker-rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const statistics: WorkflowEmailStepStatistics = {
  step: 'send_guide',
  from: null,
  to: null,
  total: 1240,
  waiting: 3,
  sent: 1100,
  delivered: null,
  bounced: 12,
  failed: 5,
  skipped: {
    total: 120,
    reasons: [
      { reason: 'no_consent', count: 20 },
      { reason: 'unsubscribed', count: 95 },
      { reason: 'no_time_zone', count: 0 },
      { reason: 'other', count: 5 },
    ],
  },
  unsubscribed: 7,
  opened: null,
  clicked: null,
};

describe('the statistics of a Send email action', () => {
  it('never shows a number nobody measures as zero', () => {
    const rows = statisticRows(statistics);
    const shown = Object.fromEntries(rows.map((row) => [row.key, [row.value, row.measured]]));
    expect(shown).toEqual({
      total: ['1,240', true],
      sent: ['1,100', true],
      delivered: ['Not measured', false],
      waiting: ['3', true],
      failed: ['5', true],
      bounced: ['12', true],
      skipped: ['120', true],
      unsubscribed: ['7', true],
      opened: ['Not tracked yet', false],
      clicked: ['Not tracked yet', false],
    });
    expect(rows.find((row) => row.key === 'delivered')?.note).toBe(
      'A mail server accepting an email is not proof it reached the inbox.',
    );
  });

  it('shows a real zero as zero', () => {
    const rows = statisticRows({ ...statistics, sent: 0, delivered: 0 });
    expect(rows.find((row) => row.key === 'sent')).toMatchObject({ value: '0', measured: true });
    expect(rows.find((row) => row.key === 'delivered')).toMatchObject({
      value: '0',
      measured: true,
    });
  });

  it('lists why emails were skipped, most first, without the reasons that never happened', () => {
    expect(skipRows(statistics)).toEqual([
      { reason: 'unsubscribed', label: 'Unsubscribed', value: '95' },
      { reason: 'no_consent', label: 'No consent to marketing email', value: '20' },
      { reason: 'other', label: 'Another reason', value: '5' },
    ]);
    expect(skipReasonWords('a_reason_from_tomorrow')).toBe('a_reason_from_tomorrow');
  });

  it('counts a range back from now, to the minute, and has no start for all time', () => {
    const now = new Date('2026-10-13T18:25:43.210Z');
    expect(rangeStart('7', now)).toBe('2026-10-06T18:25:00.000Z');
    expect(rangeStart('30', now)).toBe('2026-09-13T18:25:00.000Z');
    expect(rangeStart('all', now)).toBeUndefined();
  });
});

const action = (patch: Partial<TemplateWorkflowAction>): TemplateWorkflowAction => ({
  automation: { id: 'aut_1', name: 'Wedding follow-up', status: 'active' },
  scope: 'draft',
  version: null,
  step: 'send_guide',
  label: null,
  mode: 'sync',
  sourceRevision: null,
  current: null,
  ...patch,
});

describe('who else uses a template', () => {
  const actions = [
    action({}),
    action({ scope: 'published', mode: 'copy' }),
    action({ step: 'second', label: 'Reminder' }),
    action({
      automation: { id: 'aut_2', name: 'DJ enquiry', status: 'paused' },
      mode: 'reference',
    }),
  ];

  it('leaves out the action itself, and lists one that is in a draft and running once', () => {
    expect(otherUses(actions, { automation: 'aut_1', step: 'second' })).toEqual([
      { key: 'aut_1:send_guide', name: 'Wedding follow-up', mode: 'copy', published: true },
      { key: 'aut_2:send_guide', name: 'DJ enquiry', mode: 'reference', published: false },
    ]);
  });

  it('names an action by its own name too, when it has one', () => {
    expect(otherUses(actions, { automation: undefined, step: undefined })[1]).toEqual({
      key: 'aut_1:second',
      name: 'Wedding follow-up · Reminder',
      mode: 'sync',
      published: false,
    });
  });

  it('counts workflows, not actions', () => {
    expect(workflowCount(actions)).toBe(2);
    expect(workflowCount([])).toBe(0);
  });

  it('says how each uses it', () => {
    expect([modeWords('sync'), modeWords('reference'), modeWords('copy')]).toEqual([
      'syncs with it',
      'sends it as it is',
      'holds a copy',
    ]);
  });
});

it('writes a file’s size as people read it', () => {
  expect([fileSizeWords(512), fileSizeWords(840 * 1024), fileSizeWords(2.4 * 1024 * 1024)]).toEqual(
    ['512 B', '840 KB', '2.4 MB'],
  );
});

describe('the rows of the template picker', () => {
  const summary = (name: string, format: 'text' | 'html', path: string[] | null) => ({
    id: `tmpl_${name}`,
    name,
    subject: `Subject of ${name}`,
    format,
    preheader: null,
    folder: path === null ? null : { id: 'fld', name: path.at(-1) ?? '', path },
    preview: '',
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T09:00:00.000Z',
    archivedAt: null,
    revision: 'a'.repeat(64),
  });
  const marks = { formatted: 'Formatted', plain: 'Plain text' };

  it('lists unfiled templates first, then each folder by its path, with subject and format', () => {
    const rows = templateItems(
      [
        summary('Zeta', 'html', ['Sales', 'Weddings']),
        summary('Alpha', 'text', null),
        summary('Beta', 'html', ['Sales']),
        summary('Gamma', 'text', ['Sales', 'Weddings']),
      ],
      marks,
    );
    expect(rows.map((row) => [row.name, row.group, row.mark, row.detail])).toEqual([
      ['Alpha', undefined, 'Plain text', 'Subject of Alpha'],
      ['Beta', 'Sales', 'Formatted', 'Subject of Beta'],
      ['Zeta', 'Sales / Weddings', 'Formatted', 'Subject of Zeta'],
      ['Gamma', 'Sales / Weddings', 'Plain text', 'Subject of Gamma'],
    ]);
    expect(folderPath({ folder: { id: 'f', name: 'x', path: [] } })).toBeUndefined();
  });

  it('finds the template a step names by id, or by name as an older step may', () => {
    const known = [
      { id: 'tmpl_1', name: 'Pricing guide' },
      { id: 'tmpl_2', name: 'Welcome' },
    ];
    expect(namedTemplate(known, 'tmpl_2')?.name).toBe('Welcome');
    expect(namedTemplate(known, ' pricing GUIDE ')?.id).toBe('tmpl_1');
    expect(namedTemplate(known, 'Gone')).toBeUndefined();
    expect(namedTemplate(known, undefined)).toBeUndefined();
    expect(namedTemplate(known, '')).toBeUndefined();
  });
});
