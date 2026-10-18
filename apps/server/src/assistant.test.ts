import type { Invocation, Services } from '@repo/commands';
import { listTags, publishForm } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { describe, expect, it } from 'vitest';

import {
  assistantChips,
  assistantConfirmations,
  assistantPage,
  businessKnowledge,
  deferredToolbox,
  proposables,
} from './assistant.js';
import { taskOptions } from './task-options.js';

const profile = {
  name: 'Harbor Lights Events',
  timezone: 'Africa/Nairobi',
  currency: 'KES',
  address: null,
};

describe('what a business has written down for a draft to draw on', () => {
  it('is its own profile: its name, and the time and money it works in', () => {
    expect(businessKnowledge(profile)).toEqual([
      {
        title: 'About the business',
        text: 'Name: Harbor Lights Events. Time zone: Africa/Nairobi. Currency: KES.',
      },
    ]);
  });

  it('says where the business is, from the parts of its address that are filled in', () => {
    const [about] = businessKnowledge({
      ...profile,
      address: {
        line1: ' 12 Quay Road ',
        line2: '',
        city: 'Mombasa',
        region: '   ',
        postalCode: '80100',
        country: 'KE',
      },
    });
    expect(about?.text).toBe(
      'Name: Harbor Lights Events. Address: 12 Quay Road, Mombasa, 80100, KE. Time zone: Africa/Nairobi. Currency: KES.',
    );
  });

  it('leaves the address out when none of it is filled in', () => {
    const [about] = businessKnowledge({
      ...profile,
      address: { line1: '', line2: ' ', city: '', region: '', postalCode: '', country: '' },
    });
    expect(about?.text).toBe(
      'Name: Harbor Lights Events. Time zone: Africa/Nairobi. Currency: KES.',
    );
  });
});

describe('what the in-app assistant is composed with', () => {
  const invocation: Invocation = {
    context: {
      agencyId: '01890a5d-ac96-774b-bcce-b302099a8050',
      businessId: '01890a5d-ac96-774b-bcce-b302099a8051',
      actorKind: 'user',
      correlationId: '01890a5d-ac96-774b-bcce-b302099a8053',
    },
    permissions: 'all',
  };
  // No page here reads a row: a transaction that is asked for anything is a fault.
  const trx = {} as DatabaseTransaction;

  it('offers the form builder’s chips on the forms pages and leaves the rest to the general ones', () => {
    expect(assistantChips({ route: '/forms' })?.map((chip) => chip.code)).toEqual([
      'forms.build',
      'forms.review',
    ]);
    expect(assistantChips({ route: '/forms/form_1/submissions' })).toHaveLength(2);
    for (const route of ['/', '/contacts', '/formsets', '/settings/forms'])
      expect(assistantChips({ route })).toBeUndefined();
  });

  it('says nothing of a page that is about no form, and of any page without a public address', async () => {
    const page = assistantPage('https://crm.example.test');
    expect(await page(trx, invocation, { route: '/forms', selection: [] })).toEqual({
      subject: null,
      checks: [],
      chips: assistantChips({ route: '/forms' }),
    });
    expect(
      await page(trx, invocation, {
        route: '/contacts/con_1',
        record: { kind: 'contact', id: 'con_1' },
        selection: [],
      }),
    ).toEqual({ subject: null, checks: [], chips: assistantChips({ route: '/contacts/con_1' }) });
    // Without a public address there is no form as the API answers one.
    expect(
      await assistantPage(undefined)(trx, invocation, {
        route: '/forms/form_1',
        record: { kind: 'form', id: 'form_1' },
        selection: [],
      }),
    ).toMatchObject({ subject: null, checks: [] });
  });

  it('turns the one tool that makes something live into the proposal a person confirms', () => {
    expect(Object.keys(assistantConfirmations)).toEqual([
      'savePipelines',
      'createCalendar',
      'updateCalendar',
      'updateCalendarAvailability',
      'publishAutomation',
      'publishForm',
    ]);
    const publish = assistantConfirmations['publishForm'];
    expect(publish?.kind).toBe('form_publish');
    expect(
      publish?.input({ params: { id: 'form_1' }, body: { revision: 'abc', extra: 'ignored' } }),
    ).toEqual({ id: 'form_1', revision: 'abc' });
    // The card's line is the form's own name, never a model's words.
    expect(publish?.summary({ name: ' Wedding enquiry ' })).toBe(
      'Publish the form “Wedding enquiry”',
    );
    for (const change of [{}, { name: '  ' }, { name: 4 }])
      expect(publish?.summary(change)).toBe('Publish this form');
  });

  it('maps every live configuration proposal to its native input and review summary', () => {
    const body = { revision: 'a'.repeat(64), name: 'Wedding consultation' };
    const params = { id: 'native-record-id' };
    const cases = [
      ['savePipelines', 'pipeline_save', body, 'Save the pipelines and stages'],
      ['createCalendar', 'calendar_create', body, 'Create calendar “Wedding consultation”'],
      [
        'updateCalendar',
        'calendar_update',
        { id: params.id, settings: body },
        'Save calendar “Wedding consultation”',
      ],
      [
        'updateCalendarAvailability',
        'calendar_availability',
        { ...body, id: params.id },
        'Save availability for “Wedding consultation”',
      ],
      [
        'publishAutomation',
        'automation_publish',
        { ...body, id: params.id },
        'Publish workflow “Wedding consultation”',
      ],
    ] as const;
    for (const [operationId, kind, input, summary] of cases) {
      const confirmation = assistantConfirmations[operationId];
      expect(confirmation?.kind).toBe(kind);
      expect(confirmation?.input({ params, body })).toEqual(input);
      expect(confirmation?.summary({ name: 'Wedding consultation' })).toBe(summary);
      expect(confirmation?.summary({ name: 4 })).not.toContain('4');
    }
  });

  it('says a deal edit is a move when the stage changes, and a save otherwise', () => {
    const confirmation = assistantConfirmations['updateDeal'];
    expect(confirmation?.kind).toBe('deal_update');
    expect(
      confirmation?.input({ params: { id: 'native-deal-id' }, body: { stageId: 'stage' } }),
    ).toEqual({ id: 'native-deal-id', stageId: 'stage' });
    expect(
      confirmation?.summary({ name: 'Kanyapong Demo', moved: true, stageName: 'Negotiating' }),
    ).toBe('Move the deal “Kanyapong Demo” to Negotiating');
    expect(confirmation?.summary({ name: 'Kanyapong Demo', moved: false })).toBe(
      'Save the deal “Kanyapong Demo”',
    );
    expect(confirmation?.summary({ name: 4, moved: true })).toBe('Save the deal “Deal”');
  });

  it('offers grounded questions for each supported CRM page', () => {
    const cases = [
      ['/pipelines', ['pipelines.review', 'pipelines.build']],
      ['/calendars/native-calendar', ['calendars.review', 'calendars.build']],
      ['/automations/native-workflow', ['workflows.build', 'workflows.explain']],
      ['/contacts/native-contact', ['contact.journey', 'contact.why_not']],
      ['/reports', ['reports.ask']],
    ] as const;
    for (const [route, codes] of cases)
      expect(assistantChips({ route })?.map((chip) => chip.code)).toEqual(codes);
  });

  it('proposes publishing a form only where the install has a public address', () => {
    const inbox = { actorNames: {}, assignees: taskOptions.assignees, smsAvailable: false };
    const kinds = (publicUrl?: string) => proposables(inbox, publicUrl).map((each) => each.kind);
    expect(kinds()).not.toContain('form_publish');
    expect(kinds('https://crm.example.test')).toEqual([
      ...kinds(),
      'form_publish',
      'form_unpublish',
    ]);
  });

  it('gives the worker its tools once the routes exist, and faults clearly before', async () => {
    const faults: unknown[] = [];
    const services = {} as Services;
    const deferred = deferredToolbox(services, (_operationId, error) => faults.push(error));
    const { toolbox } = deferred;
    expect(() => toolbox.tools).toThrow('The assistant was asked for its tools too early.');
    const fault = new Error('the route failed');
    deferred.ready([
      {
        endpoint: listTags,
        run: () => Promise.reject(fault),
      },
      {
        endpoint: publishForm,
        run: () => Promise.reject(new Error('never run')),
      },
    ]);
    expect(toolbox.tools.map((tool) => [tool.operationId, tool.effect])).toEqual([
      ['listTags', 'read'],
      ['publishForm', 'confirm'],
    ]);
    const [read, publish] = toolbox.tools;
    if (read === undefined || publish === undefined) throw new Error('Missing tools.');
    // A route's own fault is reported, and the model is told only that it failed.
    expect(await toolbox.run(read, {}, invocation)).toMatchObject({ ok: false, code: 'failed' });
    expect(faults).toEqual([fault]);
    expect(
      toolbox.check(publish, {
        params: { id: 'form_01h455vb4pex5vsknk084sn02q' },
        body: { revision: 'a'.repeat(64) },
      }),
    ).toMatchObject({ ok: true });
  });
});
