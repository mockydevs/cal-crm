import { i18n } from '@lingui/core';
import {
  automationFieldWrite,
  automationStepTypes,
  validateAutomation,
  type AutomationSetup,
} from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { harborSetup, welcome } from '../e2e/automation-fixtures';
import {
  addableFilters,
  choiceAt,
  dealChangeKinds,
  dealChangeMembers,
  dealChangesOf,
  dealCustomFields,
  dealFieldsOf,
  dealFilterKinds,
  dealFiltersOf,
  grouped,
  isDated,
  isNumeric,
  membersOf,
  membersWritten,
  modesFor,
  nextWriteRow,
  sourceFields,
  starterChange,
  starterFilter,
  starterValue,
  today,
  tokenOf,
  withMode,
  withOnlyIfEmpty,
  withWriteField,
  writableFields,
  writeOf,
  writeRowOf,
  writeRowsOf,
  writtenFields,
  type FieldChoice,
  type WriteMode,
} from './automation-record-rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const setup: AutomationSetup = {
  ...harborSetup,
  fields: {
    contact: [
      ...harborSetup.fields.contact,
      { key: 'budget', aliases: ['spend'], type: 'number', options: [] },
      { key: 'visits', aliases: [], type: 'number', options: [] },
      { key: 'event_date', aliases: [], type: 'date', options: [] },
      { key: 'first_enquiry', aliases: [], type: 'datetime', options: [] },
      { key: 'utm_source', aliases: [], type: 'text', options: [] },
      { key: 'lead_source_raw', aliases: [], type: 'text', options: [] },
      { key: 'newsletter', aliases: [], type: 'boolean', options: [] },
      { key: 'notes', aliases: [], type: 'long_text', options: [] },
      {
        key: 'venue',
        aliases: [],
        type: 'single_choice',
        options: [
          { key: 'garden', label: 'Garden' },
          { key: 'hall', label: 'Hall' },
        ],
      },
    ],
    deal: [
      { key: 'service', aliases: ['package'], type: 'text', options: [] },
      { key: 'guests', aliases: [], type: 'number', options: [] },
      { key: 'extras', aliases: [], type: 'multi_choice', options: [] },
    ],
  },
  users: [
    { id: 'usr_dana', name: 'Dana Brooks' },
    { id: 'usr_chris', name: 'Chris Marino' },
    { id: 'usr_sam', name: 'Sam Okoye' },
  ],
};
const field = (path: string): FieldChoice => {
  const found = [...writableFields(setup), ...sourceFields(setup, true)].find(
    (each) => each.path === path,
  );
  if (found === undefined) throw new Error(`No field at ${path}.`);
  return found;
};

describe('who an Assign owner step names', () => {
  it('reads one member, several in turn, and a member named by what people call them', () => {
    expect(membersOf({ user: 'usr_dana' }, setup.users)).toEqual({
      ids: ['usr_dana'],
      unknown: [],
    });
    expect(membersOf({ users: ['usr_chris', 'usr_dana'] }, setup.users)).toEqual({
      ids: ['usr_chris', 'usr_dana'],
      unknown: [],
    });
    expect(membersOf({ user: ' chris marino ' }, setup.users).ids).toEqual(['usr_chris']);
    expect(membersOf({}, setup.users)).toEqual({ ids: [], unknown: [] });
  });

  it('keeps in sight a member the team lacks, and names each member once', () => {
    expect(
      membersOf({ users: ['usr_dana', 'usr_gone', 'Dana Brooks', 7, ''] }, setup.users),
    ).toEqual({
      ids: ['usr_dana'],
      unknown: ['usr_gone'],
    });
    // Two people of one name can't be told apart by it.
    const twins = [...setup.users, { id: 'usr_twin', name: 'Dana Brooks' }];
    expect(membersOf({ user: 'Dana Brooks' }, twins)).toEqual({
      ids: [],
      unknown: ['Dana Brooks'],
    });
  });

  it('writes one as user and several as users, each a shape the contract accepts', () => {
    expect(membersWritten([])).toEqual({ user: undefined, users: undefined });
    expect(membersWritten(['usr_dana'])).toEqual({ user: 'usr_dana', users: undefined });
    expect(membersWritten(['usr_dana', 'usr_chris'])).toEqual({
      user: undefined,
      users: ['usr_dana', 'usr_chris'],
    });
    const schema = automationStepTypes['owner.assign'].config;
    for (const chosen of [['usr_dana'], ['usr_dana', 'usr_chris']]) {
      const { user, users } = membersWritten(chosen);
      const config = {
        ...(user === undefined ? {} : { user }),
        ...(users === undefined ? {} : { users }),
        onlyIfUnassigned: true,
      };
      expect(schema.safeParse(config).success).toBe(true);
    }
  });
});

describe('the fields a record step can pick', () => {
  it("lists what an Update contact step can write: the contact's own four, then custom fields, never a list", () => {
    expect(writableFields(setup).map((each) => [each.group, each.path, each.label])).toEqual([
      ['contact', 'contact.firstName', 'First name'],
      ['contact', 'contact.lastName', 'Last name'],
      ['contact', 'contact.email', 'Email'],
      ['contact', 'contact.phone', 'Phone'],
      ['custom', 'contact.custom.budget', 'Budget'],
      ['custom', 'contact.custom.visits', 'Visits'],
      ['custom', 'contact.custom.event_date', 'Event date'],
      ['custom', 'contact.custom.first_enquiry', 'First enquiry'],
      ['custom', 'contact.custom.utm_source', 'Utm source'],
      ['custom', 'contact.custom.lead_source_raw', 'Lead source raw'],
      ['custom', 'contact.custom.newsletter', 'Newsletter'],
      ['custom', 'contact.custom.notes', 'Notes'],
      ['custom', 'contact.custom.venue', 'Venue'],
    ]);
    expect(dealCustomFields(setup).map((each) => each.path)).toEqual([
      'deal.custom.service',
      'deal.custom.guests',
    ]);
  });

  it('lists what a value can be read from, the opportunity in hand last, and custom values for text', () => {
    const paths = sourceFields(setup).map((each) => each.path);
    expect(paths).toContain('contact.source');
    expect(paths).toContain('contact.custom.services');
    for (const path of [
      'deal.name',
      'deal.stage',
      'deal.pipeline',
      'deal.status',
      'deal.value',
      'deal.source',
      'deal.custom.service',
    ])
      expect(paths).toContain(path);
    expect(paths.some((path) => path.startsWith('custom_values.'))).toBe(false);
    expect(sourceFields(setup, true).at(-1)).toMatchObject({
      path: 'custom_values.sample_reel_url',
      group: 'values',
    });
  });

  it('offers no field a merge field cannot name: every one passes the checks in a message', () => {
    for (const source of sourceFields(setup, true)) {
      const result = validateAutomation(
        {
          ...welcome,
          start: 'say',
          steps: {
            say: { type: 'note.create', config: { text: `Hello ${tokenOf(source.path)}` } },
          },
        },
        setup,
      );
      expect([source.path, result.errors]).toEqual([source.path, []]);
    }
  });

  it('puts fields under the headings a picker shows, and leaves out a heading with nothing', () => {
    expect(
      grouped(sourceFields(setup, true)).map((group) => [group.label, group.fields.length > 0]),
    ).toEqual([
      ['Contact', true],
      ['Contact custom fields', true],
      ['Opportunity (found or created in this workflow)', true],
      ["This lead's arrival", true],
      ['Attribution (first)', true],
      ['Attribution (latest)', true],
      ['Custom values', true],
    ]);
    expect(
      grouped(writableFields({ fields: { contact: [], deal: [] } })).map((group) => group.group),
    ).toEqual(['contact']);
  });

  it('names a custom field as the business does, and lists a contact\u2019s folder by folder', () => {
    const forms = { id: 'ffld_forms', name: 'Form answers' };
    const named: AutomationSetup = {
      ...setup,
      fields: {
        contact: [
          {
            key: 'diet',
            aliases: [],
            type: 'text',
            options: [],
            label: 'Dietary needs',
            folder: forms,
          },
          // No name, or an empty one: its key in words. No folder: the shared heading.
          { key: 'utm_source', aliases: [], type: 'text', options: [], label: '  ', folder: null },
          { key: 'budget', aliases: [], type: 'number', options: [] },
          {
            key: 'guests',
            aliases: [],
            type: 'number',
            options: [],
            label: 'Guests',
            folder: forms,
          },
        ],
        deal: [
          {
            key: 'deposit',
            aliases: [],
            type: 'number',
            options: [],
            label: 'Deposit paid',
            folder: forms,
          },
        ],
      },
    };
    expect(
      grouped(sourceFields(named)).map((group) => [
        group.group,
        group.label,
        group.fields.filter((each) => each.path.includes('.custom.')).map((each) => each.label),
      ]),
    ).toEqual([
      ['contact', 'Contact', []],
      ['custom', 'Contact: Form answers', ['Dietary needs', 'Guests']],
      ['custom', 'Contact custom fields', ['Utm source', 'Budget']],
      // An opportunity's fields stay under the opportunity, whatever folder they are in.
      ['opportunity', 'Opportunity (found or created in this workflow)', ['Deposit paid']],
      ['arrival', "This lead's arrival", []],
      ['first', 'Attribution (first)', []],
      ['latest', 'Attribution (latest)', []],
    ]);
    expect(dealCustomFields(named).map((each) => [each.label, each.heading])).toEqual([
      ['Deposit paid', undefined],
    ]);
  });

  it('finds a field written in full, the short way or by an alias, and nothing for no field', () => {
    const fields = writableFields(setup);
    expect(choiceAt(fields, 'contact.custom.budget', setup)?.label).toBe('Budget');
    expect(choiceAt(fields, 'contact.budget', setup)?.path).toBe('contact.custom.budget');
    expect(choiceAt(fields, 'contact.spend', setup)?.path).toBe('contact.custom.budget');
    expect(choiceAt(dealCustomFields(setup), 'deal.package', setup)?.path).toBe(
      'deal.custom.service',
    );
    expect(choiceAt(fields, 'contact.shoe_size', setup)).toBeUndefined();
    expect(choiceAt(fields, 'company.name', setup)).toBeUndefined();
    expect(choiceAt(fields, 'contact', setup)).toBeUndefined();
    expect(choiceAt(fields, 'contact.other.budget', setup)).toBeUndefined();
  });

  it('tells numbers and dates from the rest, and says today as a date box holds it', () => {
    expect([
      isNumeric('number'),
      isNumeric('money'),
      isNumeric('text'),
      isNumeric(undefined),
    ]).toEqual([true, true, false, false]);
    expect([isDated('date'), isDated('datetime'), isDated('number')]).toEqual([true, true, false]);
    expect(today(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/** Every shape the contract lets a contact.update step write to a field. */
const shapes: readonly (readonly [name: string, written: unknown, mode: WriteMode])[] = [
  ['text', 'Sam', 'value'],
  ['empty text', '', 'value'],
  ['a number', 12.5, 'value'],
  ['yes or no', false, 'value'],
  ['nothing, to empty the field', null, 'clear'],
  ['another field alone', '{{contact.custom.utm_source}}', 'copy'],
  ["an opportunity's field alone", '{{deal.name}}', 'copy'],
  ['text with a merge field in it', 'From {{contact.custom.utm_source}} ads', 'text'],
  ['a merge field written with spaces', '{{ contact.firstName }}', 'text'],
  ['a custom value alone', '{{custom_values.sample_reel_url}}', 'text'],
  ['now', { op: 'now' }, 'now'],
  ['a year from today', { op: 'date_add', days: 365 }, 'date_add'],
  ['days from now, written out', { op: 'date_add', value: 'now', days: -3 }, 'date_add'],
  ['days from a date', { op: 'date_add', value: '2026-12-01', days: 30 }, 'date_add'],
  [
    'days from a date and time',
    { op: 'date_add', value: '2026-12-01T09:00:00+03:00', days: 1 },
    'date_add',
  ],
  [
    'days from a date field',
    { op: 'date_add', field: 'contact.custom.event_date', days: -2 },
    'date_add',
  ],
  [
    'days from a field and a date at once',
    { op: 'date_add', field: 'contact.custom.event_date', value: '2026-12-01', days: 1 },
    'other',
  ],
  [
    'a field plus a number',
    { op: 'math', left: 'contact.custom.visits', operator: '+', right: 1 },
    'math',
  ],
  [
    'a number divided by a field',
    { op: 'math', left: 100, operator: '/', right: 'contact.custom.visits' },
    'math',
  ],
  ['a product', { op: 'math', left: 2, operator: '*', right: 3 }, 'math'],
  [
    'a difference',
    { op: 'math', left: 'contact.custom.budget', operator: '-', right: 'contact.custom.visits' },
    'math',
  ],
];
const wrappers: readonly (readonly [name: string, wrap: (value: unknown) => unknown])[] = [
  ['bare', (value) => value],
  ['under set', (value) => ({ set: value })],
  ['only if empty', (value) => ({ set: value, onlyIfEmpty: true })],
  ['under set, not only if empty', (value) => ({ set: value, onlyIfEmpty: false })],
];
const everyShape = shapes.flatMap(([name, written, mode]) =>
  wrappers.map(([wrapper, wrap]) => ({
    name: `${name}, ${wrapper}`,
    written: wrap(written),
    mode,
  })),
);

describe('what an Update contact step writes, as rows', () => {
  it.each(everyShape)(
    'reads $name as a row and writes back exactly what was stored',
    ({ written, mode }) => {
      // The shape is one the contract's own schema accepts: nothing here is made up.
      expect(automationFieldWrite.safeParse(written).success).toBe(true);
      const row = writeRowOf('contact.custom.budget', written);
      expect(row.written.mode).toBe(mode);
      expect(writeOf(row)).toEqual(written);
      expect(automationFieldWrite.safeParse(writeOf(row)).success).toBe(true);
    },
  );

  it('keeps as written what no row can hold', () => {
    for (const odd of [
      ['a', 'list'],
      { op: 'now', extra: true },
      { op: 'date_add', days: 'three' },
      { op: 'date_add', value: 7, days: 1 },
      { op: 'math', left: 1, operator: '%', right: 2 },
      { op: 'math', left: null, operator: '+', right: 2 },
      { op: 'power', left: 1 },
      { set: 'x', onlyIfEmpty: 'yes' },
      { set: 'x', also: 1 },
    ]) {
      const row = writeRowOf('contact.firstName', odd);
      expect(row.written).toEqual({ mode: 'other', raw: odd });
      expect(writeOf(row)).toEqual(odd);
    }
  });

  it('reads a whole step, in the order written, and nothing for what is not an object', () => {
    const fields = {
      'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}',
      'contact.custom.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true },
    };
    const rows = writeRowsOf(fields);
    expect(rows?.map((row) => [row.field, row.written.mode, row.onlyIfEmpty])).toEqual([
      ['contact.custom.lead_source_raw', 'copy', undefined],
      ['contact.custom.first_enquiry', 'now', true],
    ]);
    expect(writtenFields(rows ?? [])).toEqual(fields);
    expect(writeRowsOf(undefined)).toEqual([]);
    expect(writeRowsOf('fields')).toBeUndefined();
    expect(writeRowsOf(['a'])).toBeUndefined();
  });

  it('writes a row ticked "only if empty" under set, and bare again once unticked', () => {
    const row = writeRowOf('contact.firstName', 'Sam');
    const ticked = withOnlyIfEmpty(row, true);
    expect(writeOf(ticked)).toEqual({ set: 'Sam', onlyIfEmpty: true });
    expect(writeOf(withOnlyIfEmpty(ticked, false))).toBe('Sam');
    expect(
      writeOf(
        withOnlyIfEmpty(writeRowOf('contact.firstName', { set: 'Sam', onlyIfEmpty: false }), false),
      ),
    ).toBe('Sam');
  });

  it('offers the ways that fit the kind of field', () => {
    expect(modesFor(field('contact.firstName'))).toEqual(['value', 'copy', 'text', 'clear']);
    expect(modesFor(field('contact.email'))).toEqual(['value', 'copy', 'text']);
    expect(modesFor(field('contact.phone'))).toEqual(['value', 'copy', 'text']);
    expect(modesFor(field('contact.custom.budget'))).toEqual([
      'value',
      'copy',
      'text',
      'math',
      'clear',
    ]);
    expect(modesFor(field('contact.custom.event_date'))).toEqual([
      'value',
      'copy',
      'text',
      'now',
      'date_add',
      'clear',
    ]);
    expect(modesFor(undefined)).toEqual(['value', 'copy', 'text', 'clear']);
  });

  it('starts a value from something of the kind', () => {
    expect(starterValue(field('contact.firstName'))).toBe('');
    expect(starterValue(field('contact.custom.budget'))).toBe(0);
    expect(starterValue(field('contact.custom.newsletter'))).toBe(true);
    expect(starterValue(field('contact.custom.event_date'))).toBe(today());
    expect(starterValue(field('contact.custom.venue'))).toBe('garden');
    expect(starterValue({ ...field('contact.custom.venue'), options: [] })).toBe('');
    expect(starterValue(undefined)).toBe('');
  });

  it('turns a row to another way of setting its field, each from something the checks accept', () => {
    const sources = sourceFields(setup);
    const check = (path: string, written: unknown): unknown =>
      validateAutomation(
        {
          ...welcome,
          start: 'set',
          steps: { set: { type: 'contact.update', config: { fields: { [path]: written } } } },
        },
        setup,
      ).errors;
    const cases: readonly (readonly [string, WriteMode, unknown])[] = [
      ['contact.custom.lead_source_raw', 'copy', '{{contact.firstName}}'],
      ['contact.custom.lead_source_raw', 'text', 'x'],
      ['contact.custom.lead_source_raw', 'clear', null],
      ['contact.custom.first_enquiry', 'now', { op: 'now' }],
      ['contact.custom.event_date', 'date_add', { op: 'date_add', days: 1 }],
      [
        'contact.custom.visits',
        'math',
        { op: 'math', left: 'contact.custom.visits', operator: '+', right: 1 },
      ],
      ['contact.custom.budget', 'value', 0],
      ['contact.custom.budget', 'copy', '{{contact.custom.visits}}'],
    ];
    for (const [path, mode, expected] of cases) {
      const from = writeRowOf(path, mode === 'value' ? null : 'x');
      const next = writeOf(withMode(from, mode, field(path), sources));
      expect([path, mode, next]).toEqual([path, mode, expected]);
      expect([path, mode, check(path, next)]).toEqual([path, mode, []]);
    }
  });

  it('keeps the text when a row turns to text, and the row when the way is the same or unknown', () => {
    const sources = sourceFields(setup);
    const text = field('contact.firstName');
    expect(writeOf(withMode(writeRowOf('contact.firstName', 'Sam'), 'text', text, sources))).toBe(
      'Sam',
    );
    expect(
      writeOf(
        withMode(writeRowOf('contact.firstName', '{{contact.lastName}}'), 'text', text, sources),
      ),
    ).toBe('{{contact.lastName}}');
    expect(writeOf(withMode(writeRowOf('contact.firstName', 7), 'text', text, sources))).toBe('');
    const same = writeRowOf('contact.firstName', null);
    expect(withMode(same, 'clear', text, sources)).toBe(same);
    expect(withMode(same, 'other', text, sources)).toBe(same);
    // With no other field to copy from, it still writes a merge field.
    expect(writeOf(withMode(same, 'copy', text, [text]))).toBe('{{contact.firstName}}');
    // It copies from a field of the same kind first.
    expect(
      writeOf(
        withMode(
          writeRowOf('contact.custom.visits', 1),
          'copy',
          field('contact.custom.visits'),
          sources,
        ),
      ),
    ).toBe('{{contact.custom.budget}}');
  });

  it('starts a typed value again when the field changes, and keeps a way that still fits', () => {
    const budget = field('contact.custom.budget');
    const date = field('contact.custom.event_date');
    expect(writeOf(withWriteField(writeRowOf('contact.firstName', 'Sam'), budget))).toBe(0);
    expect(
      withWriteField(writeRowOf('contact.firstName', '{{contact.lastName}}'), budget),
    ).toMatchObject({
      field: 'contact.custom.budget',
      written: { mode: 'copy', from: 'contact.lastName' },
    });
    expect(
      writeOf(withWriteField(writeRowOf('contact.custom.first_enquiry', { op: 'now' }), date)),
    ).toEqual({
      op: 'now',
    });
    // Now is for dates: a number field starts again.
    expect(
      writeOf(withWriteField(writeRowOf('contact.custom.first_enquiry', { op: 'now' }), budget)),
    ).toBe(0);
    expect(
      writeOf(
        withWriteField(
          writeRowOf('contact.firstName', { set: null, onlyIfEmpty: true }),
          field('contact.email'),
        ),
      ),
    ).toEqual({ set: '', onlyIfEmpty: true });
  });

  it('adds a row for the first field no row writes, until every field has one', () => {
    const fields = writableFields({ fields: { contact: [], deal: [] } });
    const first = nextWriteRow([], fields);
    expect(first).toEqual({
      field: 'contact.firstName',
      written: { mode: 'value', value: '' },
      wrapped: false,
      onlyIfEmpty: undefined,
    });
    const rows = fields.map((each) => writeRowOf(each.path, 'x'));
    expect(nextWriteRow(rows.slice(0, 1), fields)?.field).toBe('contact.lastName');
    expect(nextWriteRow(rows, fields)).toBeUndefined();
  });
});

describe("a Find opportunity step's filters", () => {
  it('has the filters its settings hold something for, in a fixed order', () => {
    expect(dealFiltersOf({ which: 'newest' })).toEqual([]);
    expect(
      dealFiltersOf({
        status: 'open',
        pipeline: 'pip_sales',
        value: { operator: 'equals', value: 1 },
      }),
    ).toEqual(['pipeline', 'status', 'value']);
  });

  it('starts each filter from something the contract accepts, where there is something to choose', () => {
    const schema = automationStepTypes['deal.find'].config;
    for (const kind of dealFilterKinds) {
      const starter = starterFilter(kind, setup, {});
      if (kind === 'nameContains') expect(starter).toBeUndefined();
      else expect([kind, schema.safeParse({ [kind]: starter }).success]).toEqual([kind, true]);
    }
    expect(starterFilter('pipeline', setup, {})).toBe('pip_sales');
    expect(starterFilter('stage', setup, { pipeline: 'Sales' })).toBe('stg_new');
    expect(starterFilter('stage', setup, { pipeline: 'pip_gone' })).toBe('stg_new');
    expect(starterFilter('customField', setup, {})).toEqual({
      field: 'deal.custom.service',
      equals: '',
    });
    const bare = { fields: { contact: [], deal: [] }, pipelines: [] };
    expect(starterFilter('customField', bare, {})).toBeUndefined();
    expect(starterFilter('pipeline', bare, {})).toBeUndefined();
    expect(starterFilter('stage', bare, {})).toBeUndefined();
  });

  it('offers each filter once, and only where there is something to choose from', () => {
    expect(addableFilters([], setup)).toEqual([...dealFilterKinds]);
    expect(addableFilters(['pipeline', 'value'], setup)).toEqual([
      'stage',
      'status',
      'nameContains',
      'customField',
    ]);
    expect(addableFilters([], { fields: { contact: [], deal: [] }, pipelines: [] })).toEqual([
      'status',
      'nameContains',
      'value',
    ]);
  });
});

describe("an Update opportunity step's rows", () => {
  it('has a row for each thing its settings change: a value is a number or a field', () => {
    expect(dealChangesOf({})).toEqual([]);
    expect(
      dealChangesOf({ amountFrom: 'contact.custom.budget', status: 'open', owner: null }),
    ).toEqual(['value', 'owner', 'status']);
    expect(dealChangesOf({ name: 'Renewal', amount: null, source: null })).toEqual([
      'name',
      'value',
      'source',
    ]);
    expect(Object.keys(dealChangeMembers)).toEqual([...dealChangeKinds]);
  });

  it("reads the custom fields it writes, and nothing for what isn't an object", () => {
    expect(dealFieldsOf({})).toEqual({});
    expect(dealFieldsOf({ fields: { 'deal.custom.service': 'video' } })).toEqual({
      'deal.custom.service': 'video',
    });
    expect(dealFieldsOf({ fields: 'video' })).toBeUndefined();
  });

  it('starts each row from something the contract accepts, or nothing for text to type', () => {
    const schema = automationStepTypes['deal.update'].config;
    for (const kind of dealChangeKinds) {
      const starter = starterChange(kind, setup);
      if (kind === 'name') expect(starter).toBeUndefined();
      else {
        if (starter === undefined) throw new Error(`No starter for ${kind}.`);
        expect([kind, schema.safeParse({ [starter[0]]: starter[1] }).success]).toEqual([
          kind,
          true,
        ]);
      }
    }
    expect(starterChange('owner', setup)).toEqual(['owner', 'usr_dana']);
    expect(starterChange('owner', { users: [] })).toEqual(['owner', null]);
  });
});
