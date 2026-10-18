import { i18n } from '@lingui/core';
import {
  automationCatalog,
  automationRunEndings,
  automationStepTypes,
  automationStopEvents,
  automationTriggerTypes,
} from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { harborSetup } from '../e2e/automation-fixtures';
import { choiceDetails } from './automation-choice-details';
import {
  cleanConfig,
  configProblems,
  currentReference,
  DEFAULT_RESUME_WINDOW,
  durationOf,
  durationParts,
  resumeWindowParts,
  resumeWindowWords,
  WINDOW_DAYS,
  fieldsOf,
  missingFields,
  referenceOptions,
  settingWords,
  shownFields,
  starterConfig,
  stepFields,
  triggerFields,
  type FieldOwner,
  type FieldSpec,
} from './automation-fields';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const catalog = automationCatalog();

/** Every member a type's config can have, across the shapes it can take. */
function configKeys(schema: Record<string, unknown>): string[] {
  const shapes = Array.isArray(schema['anyOf'])
    ? (schema['anyOf'] as Record<string, unknown>[])
    : [schema];
  return [...new Set(shapes.flatMap((shape) => Object.keys(shape['properties'] ?? {})))].toSorted();
}

const covered = (fields: readonly FieldSpec[]): string[] =>
  fields.flatMap((field) => field.covers ?? [field.key]).toSorted();

const kinds: readonly (readonly [
  FieldOwner,
  readonly { type: string; config: Record<string, unknown> }[],
])[] = [
  ['step', catalog.steps],
  ['trigger', catalog.triggers],
];
const everyType = kinds.flatMap(([owner, types]) =>
  types.map(({ type, config }) => ({ owner, type, config })),
);

/** Something acceptable for a setting a person has to fill in themselves. */
function sample(field: FieldSpec): unknown {
  if (field.key === 'reason') return 'Requested by the contact.';
  if (field.key === 'url') return 'https://hooks.example.test/lead';
  if (field.key === 'target') return 'send_guide';
  if (field.key === 'field') return 'contact.email';
  if (field.input.kind === 'automations') return field.input.many ? ['Sample'] : 'Sample';
  if (field.input.kind === 'duration') return 'P1D';
  if (field.input.kind === 'number') return 1;
  if (field.input.kind === 'choice') return field.input.options[0]?.value;
  // Followers are a list of team members.
  if (field.input.kind === 'members' && field.input.followers !== undefined) return ['Sample'];
  return 'Sample';
}

describe('the forms', () => {
  it.each(everyType)(
    '$owner $type has a field for each setting, and no other',
    ({ owner, type, config }) => {
      const fields = fieldsOf(owner, type);
      if (fields === undefined) throw new Error(`Add fields for ${type}.`);
      expect(covered(fields)).toEqual(configKeys(config));
    },
  );

  it('know no type the catalog lacks', () => {
    expect(Object.keys(stepFields).toSorted()).toEqual(Object.keys(automationStepTypes).toSorted());
    expect(Object.keys(triggerFields).toSorted()).toEqual(
      Object.keys(automationTriggerTypes).toSorted(),
    );
  });

  it.each(everyType)(
    '$owner $type can be filled in to something the contract accepts',
    ({ owner, type }) => {
      const config = starterConfig(owner, type);
      // A setting edited in JSON starts filled in: nobody has to write it blind.
      for (const field of shownFields(owner, type, config)) {
        if (field.input.kind === 'json' && field.required)
          expect(config[field.key], `${type} ${field.key}`).toBeDefined();
        if (field.required && config[field.key] === undefined) config[field.key] = sample(field);
        // An Update contact step starts with no field to set: a person adds the first.
        if (field.input.kind === 'contact_fields')
          config[field.key] = { 'contact.firstName': 'Sample' };
      }
      const cleaned = cleanConfig(owner, type, config);
      expect(missingFields(owner, type, cleaned)).toEqual([]);
      expect(configProblems(owner, type, cleaned)).toEqual({});
    },
  );

  it('have none for a type this version does not know', () => {
    expect(fieldsOf('step', 'contact.delete')).toBeUndefined();
    expect(fieldsOf('trigger', 'toString')).toBeUndefined();
    expect(starterConfig('step', 'contact.delete')).toEqual({});
    expect(cleanConfig('step', 'contact.delete', { keep: 1 })).toEqual({ keep: 1 });
    expect(configProblems('step', 'contact.delete', {})).toEqual({});
  });
});

describe('checking what a form holds', () => {
  it('retains independent copy provenance when cleaning edited email content', () => {
    const config = {
      mode: 'copy',
      source: { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) },
      subject: 'Your guide',
      body: 'Edited welcome',
      mailbox: '',
    };
    expect(cleanConfig('step', 'email.send', config)).toEqual({
      mode: 'copy',
      source: { id: 'tmpl_01h455vb4pex5vsknk084sn02q', revision: 'a'.repeat(64) },
      subject: 'Your guide',
      body: 'Edited welcome',
    });
    expect(configProblems('step', 'email.send', cleanConfig('step', 'email.send', config))).toEqual(
      {},
    );
  });
  it('names the settings still to fill in', () => {
    expect(missingFields('step', 'email.send', {})).toEqual(['subject', 'body']);
    expect(missingFields('step', 'email.send', { template: '' })).toEqual(['template']);
    expect(missingFields('step', 'email.send', { template: 'tpl_guide' })).toEqual([]);
  });

  it('asks for a lost reason only for a lost deal', () => {
    expect(missingFields('step', 'deal.close', { outcome: 'won' })).toEqual([]);
    expect(missingFields('step', 'deal.close', { outcome: 'lost' })).toEqual(['lostReason']);
    expect(shownFields('step', 'deal.close', { outcome: 'won' }).map((field) => field.key)).toEqual(
      ['outcome'],
    );
  });

  it('drops what no longer applies, and what was left empty', () => {
    expect(cleanConfig('step', 'deal.close', { outcome: 'won', lostReason: 'los_price' })).toEqual({
      outcome: 'won',
    });
    expect(
      cleanConfig('step', 'wait.event', { event: 'deal.closed', from: 'contact', timeout: 'P1D' }),
    ).toEqual({ event: 'deal.closed', timeout: 'P1D' });
    expect(cleanConfig('step', 'email.send', { template: 'tpl_guide', mailbox: '' })).toEqual({
      template: 'tpl_guide',
    });
  });

  it("puts the contract's own message under the field it is about", () => {
    expect(configProblems('step', 'webhook.call', { url: 'http://insecure.example.test' })).toEqual(
      {
        url: 'Use an https:// address.',
      },
    );
    expect(Object.keys(configProblems('step', 'wait', { duration: '2 days' }))).toEqual([
      'duration',
    ]);
    expect(configProblems('step', 'wait', { duration: 'P2D' })).toEqual({});
  });

  it('reports an If / else with branches of its own under its branches', () => {
    const empty = { field: '', operator: 'equals' };
    expect(
      Object.keys(
        configProblems('step', 'condition', {
          branches: [
            { name: 'one', if: empty },
            { name: 'two', if: empty },
          ],
        }),
      ),
    ).toEqual(['branches']);
    expect(Object.keys(configProblems('step', 'condition', { if: empty }))).toEqual(['if']);
  });

  it('reports a setting with alternatives by the closest one', () => {
    expect(
      Object.keys(configProblems('step', 'deal.close', { outcome: 'lost', lostReason: 7 })),
    ).toEqual(['lostReason']);
  });
});

describe('the Email verification step', () => {
  it('checks the primary email, reusing a result up to 90 days old to start with', () => {
    expect(starterConfig('step', 'email.verify')).toEqual({ maxAgeDays: 90 });
    const fields = shownFields('step', 'email.verify', { maxAgeDays: 90 });
    expect(fields.map((field) => [field.key, i18n._(field.label)])).toEqual([
      ['address', 'Email address'],
      ['maxAgeDays', 'Reuse a result up to this many days old'],
    ]);
    // The address is fixed: its one choice says which address is checked.
    const [address] = fields;
    expect(
      address?.input.kind === 'choice' && address.input.options.map((option) => option.value),
    ).toEqual(['primary']);
    expect(missingFields('step', 'email.verify', {})).toEqual([]);
  });

  it('refuses a result age outside 1 to 365 days, as the contract does', () => {
    expect(configProblems('step', 'email.verify', { maxAgeDays: 365 })).toEqual({});
    expect(Object.keys(configProblems('step', 'email.verify', { maxAgeDays: 0 }))).toEqual([
      'maxAgeDays',
    ]);
    expect(Object.keys(configProblems('step', 'email.verify', { maxAgeDays: 366 }))).toEqual([
      'maxAgeDays',
    ]);
  });
});

describe('the settings that name other automations', () => {
  const keys = (config: Record<string, unknown>): string[] =>
    shownFields('step', 'automation.remove', config).map((field) => field.key);

  it('ask which automations only where the choice names some', () => {
    expect(starterConfig('step', 'automation.remove')).toEqual({ from: 'current' });
    expect(keys({ from: 'current' })).toEqual(['from']);
    expect(keys({ from: 'automations' })).toEqual(['from', 'automations']);
    expect(keys({ from: 'all_others' })).toEqual(['from', 'except']);
    expect(keys({ from: 'all' })).toEqual(['from', 'except']);
    expect(missingFields('step', 'automation.remove', { from: 'automations' })).toEqual([
      'automations',
    ]);
    expect(missingFields('step', 'automation.remove', { from: 'all' })).toEqual([]);
    expect(missingFields('step', 'automation.run', {})).toEqual(['automation']);
  });

  it('drop a list the choice no longer uses, and keep the one it does', () => {
    const lists = { automations: ['aut_other'], except: ['aut_other'] };
    expect(cleanConfig('step', 'automation.remove', { from: 'current', ...lists })).toEqual({
      from: 'current',
    });
    expect(cleanConfig('step', 'automation.remove', { from: 'automations', ...lists })).toEqual({
      from: 'automations',
      automations: ['aut_other'],
    });
    expect(cleanConfig('step', 'automation.remove', { from: 'all', ...lists })).toEqual({
      from: 'all',
      except: ['aut_other'],
    });
  });

  it('say each choice in a sentence of its own', () => {
    const [from] = fieldsOf('step', 'automation.remove') ?? [];
    if (from?.input.kind !== 'choice') throw new Error('The choice of what to remove from.');
    expect(from.input.radios).toBe(true);
    expect(from.input.options.map((option) => option.value)).toEqual([
      'current',
      'automations',
      'all_others',
      'all',
    ]);
    const sentences = from.input.options.flatMap((option) => {
      const detail = choiceDetails['from']?.[option.value];
      return detail === undefined ? [] : [i18n._(detail)];
    });
    expect(sentences).toHaveLength(4);
    for (const sentence of sentences) expect(sentence).toMatch(/\.$/);
  });

  it("put the contract's refusal of too long a list under that list", () => {
    const many = Array.from({ length: 21 }, (_, index) => `aut_${String(index)}`);
    expect(
      Object.keys(
        configProblems('step', 'automation.remove', { from: 'automations', automations: many }),
      ),
    ).toEqual(['automations']);
    expect(
      Object.keys(configProblems('step', 'automation.remove', { from: 'all', except: many })),
    ).toEqual(['except']);
    expect(
      configProblems('step', 'automation.remove', { from: 'all', except: many.slice(0, 20) }),
    ).toEqual({});
  });
});

describe('the trigger for a run that ended', () => {
  const keys = (config: Record<string, unknown>): string[] =>
    shownFields('trigger', 'automation.run_ended', config).map((field) => field.key);

  it('asks what stopped the run only while a stopped run can count', () => {
    expect(keys({})).toEqual(['automations', 'how', 'stoppedBy']);
    expect(keys({ how: [] })).toEqual(['automations', 'how', 'stoppedBy']);
    expect(keys({ how: ['stopped', 'failed'] })).toEqual(['automations', 'how', 'stoppedBy']);
    expect(keys({ how: ['completed'] })).toEqual(['automations', 'how']);
    expect(
      cleanConfig('trigger', 'automation.run_ended', {
        automations: ['aut_other'],
        how: ['completed'],
        stoppedBy: ['message.received'],
      }),
    ).toEqual({ automations: ['aut_other'], how: ['completed'] });
    expect(missingFields('trigger', 'automation.run_ended', {})).toEqual(['automations']);
  });

  it('offers every ending and every stop event the contract has, and reads them', () => {
    const fields = fieldsOf('trigger', 'automation.run_ended') ?? [];
    const options = (key: string): string[] => {
      const input = fields.find((field) => field.key === key)?.input;
      return input?.kind === 'choices' ? input.options.map((option) => option.value) : [];
    };
    expect(options('how')).toEqual([...automationRunEndings]);
    expect(options('stoppedBy')).toEqual([...automationStopEvents]);
    const how = fields.find((field) => field.key === 'how');
    if (how === undefined) throw new Error('How the run ended.');
    expect(settingWords(how, ['stopped', 'failed'], harborSetup)).toBe('Stopped or Failed');
    expect(settingWords(how, [], harborSetup)).toBe('[]');
  });
});

describe('an If / else with branches of its own', () => {
  it('is shown as it reads, in place of the single condition', () => {
    const keys = (config: Record<string, unknown>): string[] =>
      shownFields('step', 'condition', config).map((field) => field.key);
    // With one condition, the second setting is the way to give it branches of its own.
    expect(keys({ if: { field: 'contact.email', operator: 'is_set' } })).toEqual([
      'if',
      'branches',
    ]);
    expect(keys({ branches: [] })).toEqual(['branches']);
    expect(missingFields('step', 'condition', { if: {} })).toEqual([]);
    expect(missingFields('step', 'condition', {})).toEqual(['if']);
    expect(cleanConfig('step', 'condition', { branches: [], if: {} })).toEqual({ branches: [] });
  });
});

describe('a goal and a Go To', () => {
  it('start a goal on one event and going on anyway, with a sentence for each choice', () => {
    expect(starterConfig('step', 'goal')).toEqual({
      events: [{ type: 'appointment.booked', config: {} }],
      otherwise: 'continue',
    });
    const otherwise = fieldsOf('step', 'goal')?.find((field) => field.key === 'otherwise');
    if (otherwise?.input.kind !== 'choice') throw new Error('What a goal does when not met.');
    expect(otherwise.input.radios).toBe(true);
    expect(otherwise.input.options.map((option) => option.value)).toEqual([
      'continue',
      'wait',
      'end',
    ]);
    for (const option of otherwise.input.options)
      expect(choiceDetails['otherwise']?.[option.value]).toBeDefined();
    expect(fieldsOf('step', 'goal')?.[0]?.input.kind).toBe('goal_events');
  });

  it('ask a Go To which action, as a choice among the steps', () => {
    expect(fieldsOf('step', 'goto')?.map((field) => [field.key, field.input.kind])).toEqual([
      ['target', 'step'],
    ]);
    expect(missingFields('step', 'goto', {})).toEqual(['target']);
  });
});

describe('who a team notification tells', () => {
  it('offers the owner, everyone, and the owner with everyone as the fallback', () => {
    const to = fieldsOf('step', 'team.notify')?.find((field) => field.key === 'to');
    if (to?.input.kind !== 'choice') throw new Error('The choice of who to tell.');
    expect(to.input.options.map((option) => [option.value, i18n._(option.label)])).toEqual([
      ['contact_owner', "The contact's owner"],
      ['everyone', 'Everyone on the team'],
      ['owner_or_everyone', "The contact's owner, or everyone when there is none"],
    ]);
    for (const option of to.input.options)
      expect(
        configProblems('step', 'team.notify', { message: 'New lead', to: option.value }),
      ).toEqual({});
  });
});

describe('lengths of time', () => {
  it.each([
    ['PT45S', 45, 'seconds'],
    ['PT30M', 30, 'minutes'],
    ['PT4H', 4, 'hours'],
    ['P2D', 2, 'days'],
    ['P3W', 3, 'weeks'],
  ] as const)('holds %s in the form and writes it back', (iso, amount, unit) => {
    expect(durationParts(iso)).toEqual({ amount, unit });
    expect(durationOf(amount, unit)).toBe(iso);
  });

  it.each(['P1DT4H', 'P1M', 'P1Y', 'PT1H30M', 'PT-5M', 'P', '', 'soon', 5])(
    'leaves %j to the JSON view',
    (given) => {
      expect(durationParts(given)).toBeUndefined();
    },
  );

  it('reads a window of weekdays and hours, and says it in words', () => {
    const office = { days: ['friday', 'monday'], start: '09:00', end: '17:30' };
    // In the order of the week, whatever order the document lists them in.
    expect(resumeWindowParts(office)).toEqual({
      days: ['monday', 'friday'],
      start: '09:00',
      end: '17:30',
    });
    expect(resumeWindowWords(office)).toBe('Monday and Friday, 09:00 to 17:30');
    expect(resumeWindowWords({ ...office, days: [...WINDOW_DAYS] })).toBe(
      'Every day, 09:00 to 17:30',
    );
    expect(
      automationStepTypes.wait.config.safeParse({
        duration: 'PT45S',
        resumeWindow: DEFAULT_RESUME_WINDOW,
      }).success,
    ).toBe(true);
    for (const odd of [
      undefined,
      'weekdays',
      { days: [], start: '09:00', end: '17:00' },
      { days: ['funday'], start: '09:00', end: '17:00' },
      { days: ['monday'], start: '9am', end: '17:00' },
      { days: ['monday'], start: '09:00', end: '25:00' },
      { days: ['monday'], start: '09:00' },
      { days: ['monday'], start: '09:00', end: '17:00', zone: 'UTC' },
    ]) {
      expect(resumeWindowParts(odd)).toBeUndefined();
      expect(resumeWindowWords(odd)).toBeUndefined();
    }
  });

  it('writes whole amounts, never below zero', () => {
    expect(durationOf(2.9, 'days')).toBe('P2D');
    expect(durationOf(-4, 'hours')).toBe('PT0H');
  });
});

describe("choosing one of the business's own", () => {
  it('offers them by id, under their names', () => {
    expect(referenceOptions('tags', harborSetup, {})).toEqual([
      { value: 'tag_vip', label: 'VIP' },
      { value: 'tag_cold', label: 'Cold' },
    ]);
  });

  it("offers the chosen pipeline's stages, or every pipeline's with its name", () => {
    expect(referenceOptions('stages', harborSetup, { pipeline: 'Sales' })).toEqual([
      { value: 'stg_new', label: 'New lead' },
      { value: 'stg_quoted', label: 'Quoted' },
    ]);
    expect(referenceOptions('stages', harborSetup, {})[0]).toEqual({
      value: 'stg_new',
      label: 'Sales · New lead',
    });
  });

  it('finds the option a value stands for, by id or by name', () => {
    const options = referenceOptions('tags', harborSetup, {});
    expect(currentReference(options, 'tag_vip')).toBe('tag_vip');
    expect(currentReference(options, ' vip ')).toBe('tag_vip');
    expect(currentReference(options, 'Gold')).toBeUndefined();
    expect(currentReference(options, undefined)).toBeUndefined();
    expect(
      currentReference(
        [
          { value: 'a', label: 'Same' },
          { value: 'b', label: 'Same' },
        ],
        'Same',
      ),
    ).toBeUndefined();
  });
});

describe('settingWords', () => {
  const field = (owner: FieldOwner, type: string, key: string): FieldSpec => {
    const found = fieldsOf(owner, type)?.find((each) => each.key === key);
    if (found === undefined) throw new Error(`${type} has no ${key}.`);
    return found;
  };

  it('reads each kind of setting', () => {
    expect(settingWords(field('step', 'tag.add', 'tag'), 'tag_vip', harborSetup)).toBe('VIP');
    expect(settingWords(field('step', 'deal.move', 'stage'), 'stg_quoted', harborSetup)).toBe(
      'Quoted',
    );
    expect(settingWords(field('step', 'wait', 'duration'), 'P2D', harborSetup)).toBe('2 days');
    expect(settingWords(field('step', 'team.notify', 'to'), 'everyone', harborSetup)).toBe(
      'Everyone on the team',
    );
    expect(settingWords(field('step', 'sms.send', 'message'), 'Hello', harborSetup)).toBe(
      '“Hello”',
    );
    expect(settingWords(field('step', 'deal.create', 'amount'), 250, harborSetup)).toBe('250');
    expect(
      settingWords(
        field('step', 'condition', 'if'),
        { field: 'contact.email', operator: 'is_set' },
        harborSetup,
      ),
    ).toBe('email is filled in');
    expect(
      settingWords(field('step', 'split', 'variants'), [{ name: 'a', percent: 50 }], harborSetup),
    ).toBe('[{"name":"a","percent":50}]');
    expect(settingWords(field('step', 'wait', 'duration'), undefined, harborSetup)).toBe('Not set');
    expect(
      settingWords(field('step', 'automation.run', 'automation'), 'aut_other', harborSetup),
    ).toBe('Win back');
    expect(
      settingWords(
        field('step', 'automation.remove', 'automations'),
        ['aut_other', 'Education'],
        harborSetup,
      ),
    ).toBe('Win back and Education');
    expect(settingWords(field('step', 'automation.remove', 'except'), [], harborSetup)).toBe('[]');
    expect(
      settingWords(field('step', 'automation.remove', 'from'), 'all_others', harborSetup),
    ).toBe('All other automations');
    expect(settingWords(field('step', 'team.notify', 'to'), 'nobody', harborSetup)).toBe(
      '"nobody"',
    );
  });
});
