import type { ContactImportAttribute, ImportColumnMapping } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  checkMapping,
  nameKey,
  readAttributeCell,
  readFieldCell,
  suggestMapping,
  type ImportField,
} from './mapping.js';

const field = (changes: Partial<ImportField> & Pick<ImportField, 'id' | 'key'>): ImportField => ({
  label: changes.key,
  valueType: 'text',
  options: [],
  archived: false,
  ...changes,
});

const EVENT_DATE = 'fld_01h455vb4pex5vsknk084sn02q';
const BUDGET = 'fld_01h455vb4pex5vsknk084sn02r';
const OLD = 'fld_01h455vb4pex5vsknk084sn02s';
const fields = [
  field({ id: EVENT_DATE, key: 'event_date', label: 'Event date', valueType: 'date' }),
  field({ id: BUDGET, key: 'budget', label: 'Budget (KES)', valueType: 'money' }),
  field({ id: OLD, key: 'old_notes', label: 'Old notes', archived: true }),
];

const attribute = (name: ContactImportAttribute) =>
  ({ kind: 'attribute', attribute: name }) as const;
const custom = (fieldId: string) => ({ kind: 'field', fieldId }) as const;

describe('nameKey', () => {
  it('compares names by their letters and digits alone', () => {
    expect(nameKey(' First  Name ')).toBe('firstname');
    expect(nameKey('E-mail_Address')).toBe('emailaddress');
    expect(nameKey('{{contact.event_date}}')).toBe('contacteventdate');
    expect(nameKey('Téléphone №2')).toBe('téléphoneno2');
    expect(nameKey('—')).toBe('');
  });
});

describe('suggestMapping', () => {
  it('maps the headers of a contact export to the contact’s own attributes', () => {
    expect(
      suggestMapping(
        [
          'First Name',
          'Last Name',
          'Email',
          'Phone',
          'Additional Emails',
          'Additional Phone Numbers',
          'Timezone',
          'DND',
          'Tags',
        ],
        [],
      ),
    ).toEqual([
      { column: 0, target: attribute('firstName') },
      { column: 1, target: attribute('lastName') },
      { column: 2, target: attribute('email') },
      { column: 3, target: attribute('phone') },
      { column: 4, target: attribute('additionalEmails') },
      { column: 5, target: attribute('additionalPhones') },
      { column: 6, target: attribute('timeZone') },
      { column: 7, target: attribute('doNotContact') },
      { column: 8, target: attribute('tags') },
    ]);
  });

  it('maps a custom field by its key, its name or its merge key, and never an archived one', () => {
    expect(suggestMapping(['event_date', 'BUDGET (kes)', 'Old notes'], fields)).toEqual([
      { column: 0, target: custom(EVENT_DATE) },
      { column: 1, target: custom(BUDGET) },
    ]);
    expect(
      suggestMapping(['{{contact.event_date}}', '{{ contact.custom.budget }}'], fields),
    ).toEqual([
      { column: 0, target: custom(EVENT_DATE) },
      { column: 1, target: custom(BUDGET) },
    ]);
  });

  it('leaves out what it has no name for, and gives each target to its first column only', () => {
    expect(suggestMapping(['Notes', 'Email', '', 'E-mail', 'email address'], fields)).toEqual([
      { column: 1, target: attribute('email') },
    ]);
  });

  it('prefers the contact’s own attribute to a custom field of the same name', () => {
    const phoneField = field({ id: BUDGET, key: 'phone', label: 'Phone' });
    expect(suggestMapping(['Phone'], [phoneField])).toEqual([
      { column: 0, target: attribute('phone') },
    ]);
  });
});

describe('checkMapping', () => {
  const email: ImportColumnMapping = { column: 0, target: attribute('email') };
  const check = (
    mapping: readonly ImportColumnMapping[],
    mode: 'create' | 'update' | 'create_and_update' = 'create',
    columns = 3,
  ) => checkMapping(mapping, { columns, fields, mode }).map(({ path, code }) => ({ path, code }));

  it('accepts a mapping every row can be imported with', () => {
    expect(check([email, { column: 1, target: custom(EVENT_DATE) }])).toEqual([]);
    expect(check([{ column: 2, target: attribute('firstName') }])).toEqual([]);
    expect(check([email], 'update')).toEqual([]);
    expect(check([{ column: 0, target: attribute('additionalPhones') }], 'update')).toEqual([]);
  });

  it('refuses a column the file does not have', () => {
    const [issue] = checkMapping([{ column: 3, target: attribute('email') }], {
      columns: 3,
      fields,
      mode: 'create',
    });
    expect(issue).toEqual({
      path: '/mapping/0/column',
      code: 'column_unknown',
      message: 'The file has 3 columns: there is no column 4.',
    });
  });

  it('refuses a field that is not a live contact field of the business', () => {
    expect(
      check([
        email,
        { column: 1, target: custom('fld_01h455vb4pex5vsknk084sn02z') },
        { column: 2, target: custom(OLD) },
      ]),
    ).toEqual([
      { path: '/mapping/1/target/fieldId', code: 'field_unknown' },
      { path: '/mapping/2/target/fieldId', code: 'field_archived' },
    ]);
  });

  it('refuses a mapping that could never say who a row is', () => {
    expect(
      check([
        { column: 0, target: attribute('tags') },
        { column: 1, target: custom(EVENT_DATE) },
        { column: 2, target: attribute('timeZone') },
      ]),
    ).toEqual([{ path: '/mapping', code: 'nothing_to_identify' }]);
  });

  it('refuses updating with nothing to find a contact by', () => {
    const names = [
      { column: 0, target: attribute('firstName') },
      { column: 1, target: attribute('lastName') },
    ];
    expect(check(names, 'update')).toEqual([{ path: '/mapping', code: 'nothing_to_match' }]);
    expect(check(names, 'create_and_update')).toEqual([]);
  });
});

describe('readAttributeCell', () => {
  it('reads an empty cell as nothing to change, whatever it fills', () => {
    for (const name of [
      'firstName',
      'email',
      'additionalEmails',
      'phone',
      'additionalPhones',
      'timeZone',
      'doNotContact',
      'tags',
    ] as const)
      for (const cell of ['', '   ', '\t'])
        expect(readAttributeCell(name, cell)).toEqual({ value: null });
  });

  it('keeps a name as written, trimmed, and a formula as the text it is', () => {
    expect(readAttributeCell('firstName', '  Maya ')).toEqual({ value: 'Maya' });
    expect(readAttributeCell('lastName', '=HYPERLINK("http://x.test")')).toEqual({
      value: '=HYPERLINK("http://x.test")',
    });
    expect(readAttributeCell('firstName', '@maya')).toEqual({ value: '@maya' });
    expect(readAttributeCell('timeZone', ' Africa/Nairobi ')).toEqual({ value: 'Africa/Nairobi' });
  });

  it('reads email addresses in lower case, several from one cell, each once', () => {
    expect(readAttributeCell('email', ' Maya@Example.TEST ')).toEqual({
      value: 'maya@example.test',
    });
    expect(
      readAttributeCell(
        'additionalEmails',
        'A@example.test, b@example.test;a@example.test\nc@example.test',
      ),
    ).toEqual({ value: ['a@example.test', 'b@example.test', 'c@example.test'] });
    expect(readAttributeCell('additionalEmails', ' ; , ')).toEqual({ value: null });
  });

  it('reads a phone number as written, without the apostrophe that kept it as text', () => {
    expect(readAttributeCell('phone', '+254 712 345678')).toEqual({ value: '+254 712 345678' });
    expect(readAttributeCell('phone', "'+254712345678")).toEqual({ value: '+254712345678' });
    expect(readAttributeCell('phone', "'0712 345678")).toEqual({ value: '0712 345678' });
    // Only one apostrophe, and only before a number.
    expect(readAttributeCell('phone', "''+254712345678")).toEqual({ value: "''+254712345678" });
    expect(readAttributeCell('phone', "'call me")).toEqual({ value: "'call me" });
    expect(
      readAttributeCell('additionalPhones', "'+254712345678; 0712 345678,+254712345678"),
    ).toEqual({
      value: ['+254712345678', '0712 345678'],
    });
  });

  it('reads tags separated by commas or semicolons, each once', () => {
    expect(readAttributeCell('tags', 'VIP, Wedding;VIP; ')).toEqual({ value: ['VIP', 'Wedding'] });
    expect(readAttributeCell('tags', ' , ')).toEqual({ value: null });
  });

  it('turns do not contact on for yes, changes nothing for no, and refuses anything else', () => {
    for (const cell of ['yes', 'YES', 'y', 'true', 'TRUE', '1', 'on'])
      expect(readAttributeCell('doNotContact', cell)).toEqual({ value: true });
    for (const cell of ['no', 'No', 'n', 'false', '0', 'off'])
      expect(readAttributeCell('doNotContact', cell)).toEqual({ value: null });
    expect(readAttributeCell('doNotContact', 'maybe')).toEqual({
      problem: { code: 'do_not_contact_unreadable', message: 'Use yes or no for do not contact.' },
    });
  });
});

describe('readFieldCell', () => {
  const of = (valueType: ImportField['valueType'], options: ImportField['options'] = []) =>
    field({ id: EVENT_DATE, key: 'x', valueType, options });
  const choices = [
    { key: 'opt_gold', label: 'Gold', description: '', archived: false },
    { key: 'opt_silver', label: 'Silver plan', description: '', archived: false },
    { key: 'opt_old', label: 'Bronze', description: '', archived: true },
  ];

  it('reads an empty cell as nothing to change, for every type', () => {
    for (const valueType of [
      'text',
      'long_text',
      'number',
      'money',
      'date',
      'datetime',
      'boolean',
      'single_choice',
      'multi_choice',
      'email',
      'phone',
      'url',
    ] as const)
      expect(readFieldCell(of(valueType, choices), '  ')).toEqual({ value: null });
  });

  it('keeps text as written, trimmed, formulas included', () => {
    expect(readFieldCell(of('text'), ' =1+1 ')).toEqual({ value: '=1+1' });
    expect(readFieldCell(of('long_text'), '-5 degrees\r\nand falling')).toEqual({
      value: '-5 degrees\r\nand falling',
    });
    expect(readFieldCell(of('url'), 'https://example.test/a')).toEqual({
      value: 'https://example.test/a',
    });
    expect(readFieldCell(of('email'), 'Maya@Example.test')).toEqual({ value: 'maya@example.test' });
    expect(readFieldCell(of('phone'), "'+254712345678")).toEqual({ value: '+254712345678' });
  });

  it('reads a number plainly, with thousands marked by commas, or kept as text by an apostrophe', () => {
    for (const [cell, value] of [
      ['1250', '1250'],
      ['1250.50', '1250.50'],
      ['-3.25', '-3.25'],
      ['1,234,234.33', '1234234.33'],
      ['-12,000', '-12000'],
      ["'-5", '-5'],
      ["'1250", '1250'],
    ] as const)
      for (const valueType of ['number', 'money'] as const)
        expect(readFieldCell(of(valueType), cell)).toEqual({ value });
    for (const cell of ['1,23', '12,34.5', '1.250,50', 'KES 1250', '1e3', '$5', '=1+1', '5%'])
      expect(readFieldCell(of('number'), cell)).toEqual({
        problem: { code: 'number_unreadable', message: 'Enter a number, such as 1250.50.' },
      });
  });

  it('reads a date only with the year first, since 03/04 is two different days', () => {
    expect(readFieldCell(of('date'), '2026-10-09')).toEqual({ value: '2026-10-09' });
    expect(readFieldCell(of('date'), '2026/10/09')).toEqual({ value: '2026-10-09' });
    for (const cell of ['10/09/2026', '09-10-2026', '9 Oct 2026', '2026-10-9', '20261009'])
      expect(readFieldCell(of('date'), cell)).toEqual({
        problem: {
          code: 'date_unreadable',
          message: 'Enter a date with the year first, such as 2026-10-09.',
        },
      });
  });

  it('hands a date and time on as written, for the field’s own check', () => {
    expect(readFieldCell(of('datetime'), '2026-10-09T14:30:00+03:00')).toEqual({
      value: '2026-10-09T14:30:00+03:00',
    });
  });

  it('reads yes and no', () => {
    for (const cell of ['yes', 'Y', 'TRUE', '1'])
      expect(readFieldCell(of('boolean'), cell)).toEqual({ value: true });
    for (const cell of ['no', 'N', 'false', '0'])
      expect(readFieldCell(of('boolean'), cell)).toEqual({ value: false });
    expect(readFieldCell(of('boolean'), 'perhaps')).toEqual({
      problem: { code: 'boolean_unreadable', message: 'Use yes or no.' },
    });
  });

  it('reads a choice by its key or its name, and only one still offered', () => {
    expect(readFieldCell(of('single_choice', choices), 'gold')).toEqual({ value: 'opt_gold' });
    expect(readFieldCell(of('single_choice', choices), 'OPT_SILVER')).toEqual({
      value: 'opt_silver',
    });
    for (const cell of ['Bronze', 'opt_old', 'Platinum', 'Gold, Silver plan'])
      expect(readFieldCell(of('single_choice', choices), cell)).toEqual({
        problem: { code: 'choice_unknown', message: "This isn't one of the field's choices." },
      });
  });

  it('reads several choices from one cell, each once, and refuses the cell if one is unknown', () => {
    expect(readFieldCell(of('multi_choice', choices), 'Gold; silver plan, gold')).toEqual({
      value: ['opt_gold', 'opt_silver'],
    });
    expect(readFieldCell(of('multi_choice', choices), ' ; ')).toEqual({ value: null });
    expect(readFieldCell(of('multi_choice', choices), 'Gold, Platinum')).toEqual({
      problem: {
        code: 'choice_unknown',
        message: "One of these isn't one of the field's choices.",
      },
    });
  });
});

describe('a text box list or a file upload field', () => {
  const LIST = 'fld_01h455vb4pex5vsknk084sn02t';
  const SCAN = 'fld_01h455vb4pex5vsknk084sn02v';
  const unfillable = [
    field({ id: LIST, key: 'references', label: 'References', valueType: 'text_list' }),
    field({ id: SCAN, key: 'scan', label: 'Scan', valueType: 'file' }),
  ];
  it('is never suggested for a column, and refused when chosen', () => {
    expect(suggestMapping(['Email', 'References', 'Scan'], unfillable)).toEqual([
      { column: 0, target: attribute('email') },
    ]);
    const issues = checkMapping(
      [
        { column: 0, target: attribute('email') },
        { column: 1, target: custom(LIST) },
        { column: 2, target: custom(SCAN) },
      ],
      { columns: 3, fields: unfillable, mode: 'create' },
    );
    expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
      ['/mapping/1/target/fieldId', 'field_not_importable'],
      ['/mapping/2/target/fieldId', 'field_not_importable'],
    ]);
  });
  it('reads no cell', () => {
    for (const each of unfillable)
      expect(readFieldCell(each, 'Ann')).toMatchObject({
        problem: { code: 'field_not_importable' },
      });
  });
});
