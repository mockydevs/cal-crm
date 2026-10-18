// The Filters panel's conditions as SQL. A filter is groups of conditions, all or any of
// which must hold; each condition becomes a test of the contact's own row or an `exists`
// over one indexed table, so the planner can find a rare match from its index and test a
// common one contact by contact. Values never reach the SQL text: every one is a parameter.
// Anything a condition names that this business does not have (a field, a tag, a team
// member, a choice) is refused with a pointer into `filter`, never answered as "no
// contacts", so a list that silently shows nothing is always a real empty list.
import {
  contactFilterKinds,
  contactFilterFields,
  contactEmailVerifications,
  contactSources,
  contactTypes,
  type ContactFilter,
  type ContactFilterCondition,
  type ContactFilterField,
  type ContactFilterKind,
  type ContactFilterOperator,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, ValidationError, type Issue, type TenantContext } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { countryOf } from './country.js';
import { primaryEmailState } from './email-verification-state.js';
import type { ContactDetailOptions } from './details.js';
import { normalizePhone } from './phones.js';

type Test = RawBuilder<SqlBool>;

/** What a filter needs of the module that owns the team: who a membership id names. */
export type FilterPeople = Pick<ContactDetailOptions, 'assignees'>;

/** A problem with one condition, raised with the place in `filter` it is at. */
class ConditionProblem extends Error {
  constructor(
    readonly member: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (member: string, code: string, message: string): never => {
  throw new ConditionProblem(member, code, message);
};

/** A LIKE pattern that finds the text anywhere, with the text's own wildcards escaped. */
const anywhere = (text: string): string =>
  `%${text.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

const lowered = (values: readonly string[]): string[] =>
  values.map((value) => value.trim().toLowerCase());

function operatorFor<Operator extends ContactFilterOperator>(
  operators: readonly Operator[],
  condition: ContactFilterCondition,
): Operator {
  const operator = operators.find((candidate) => candidate === condition.operator);
  if (operator === undefined)
    return refuse('operator', 'invalid_operator', 'This field cannot be compared this way.');
  return operator;
}

const one = (condition: ContactFilterCondition): string => condition.value ?? '';
const many = (condition: ContactFilterCondition): readonly string[] => condition.values ?? [];

/**
 * A text test of one expression that is null when the contact has no such text. The
 * negative operators hold for a contact without the text, as "is not Nairobi" holds for a
 * contact with no city.
 */
function textTest(column: RawBuilder<unknown>, condition: ContactFilterCondition): Test {
  const text = sql`lower(${column})`;
  switch (operatorFor(contactFilterKinds.text, condition)) {
    case 'is':
      return sql`${text} = ${one(condition).trim().toLowerCase()}`;
    case 'is_not':
      return sql`(${column} is null or ${text} <> ${one(condition).trim().toLowerCase()})`;
    case 'contains':
      return sql`${text} like ${anywhere(one(condition))}`;
    case 'not_contains':
      return sql`(${column} is null or ${text} not like ${anywhere(one(condition))})`;
    case 'any_of':
      return sql`${text} = any(${lowered(many(condition))}::text[])`;
    case 'none_of':
      return sql`(${column} is null or ${text} <> all(${lowered(many(condition))}::text[]))`;
    case 'is_empty':
      return sql`(${column} is null or ${column} = '')`;
    case 'is_not_empty':
      return sql`(${column} is not null and ${column} <> '')`;
  }
}

const NEGATIVE = new Set(['is_not', 'not_contains', 'none_of', 'is_empty']);
const POSITIVE_OF = {
  is_not: 'is',
  not_contains: 'contains',
  none_of: 'any_of',
  is_empty: 'is_not_empty',
} as const;

/**
 * A text test over rows that belong to the contact, such as its email addresses: a
 * positive operator holds when one row passes it, and a negative one when none passes its
 * opposite ("is not x" means no address is x).
 */
function anyRowTest(
  rows: (test: Test) => Test,
  column: RawBuilder<unknown>,
  condition: ContactFilterCondition,
  prepare: (value: string) => string = (value) => value,
): Test {
  const operator = condition.operator;
  const positive = NEGATIVE.has(operator)
    ? POSITIVE_OF[operator as keyof typeof POSITIVE_OF]
    : operator;
  const prepared: ContactFilterCondition = {
    ...condition,
    operator: positive,
    ...(condition.value === undefined ? {} : { value: prepare(condition.value) }),
    ...(condition.values === undefined ? {} : { values: condition.values.map(prepare) }),
  };
  const found = rows(positive === 'is_not_empty' ? sql`true` : textTest(column, prepared));
  return NEGATIVE.has(operator) ? sql`not ${found}` : found;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function instant(member: string, value: string): Date {
  const parsed = INSTANT.test(value) ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime()))
    refuse(member, 'invalid_timestamp', 'Give a moment, such as 2026-10-07T09:30:00Z.');
  return parsed;
}

function day(member: string, value: string): string {
  const parsed = DAY.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    refuse(member, 'invalid_date', 'Give a date, such as 2026-10-07.');
  return value;
}

function amount(member: string, value: string): string {
  if (!/^-?\d{1,15}(\.\d{1,6})?$/.test(value.trim()))
    refuse(member, 'invalid_number', 'Give a number in digits, such as 12.5.');
  return value.trim();
}

/** A test of a point in time. Relative ones are counted from the moment the list is read. */
function momentTest(column: RawBuilder<unknown>, condition: ContactFilterCondition): Test {
  const days = condition.days ?? 0;
  switch (operatorFor(contactFilterKinds.moment, condition)) {
    case 'before':
      return sql`${column} < ${instant('value', one(condition))}`;
    case 'after':
      return sql`${column} >= ${instant('value', one(condition))}`;
    case 'between':
      return sql`(${column} >= ${instant('from', condition.from ?? '')} and ${column} < ${instant('to', condition.to ?? '')})`;
    case 'in_last':
      return sql`(${column} >= now() - make_interval(days => ${days}::integer) and ${column} <= now())`;
    case 'not_in_last':
      return sql`${column} < now() - make_interval(days => ${days}::integer)`;
  }
}

/** A test of a calendar day. Today is the day it is in the business's time zone. */
function dateTest(
  column: RawBuilder<unknown>,
  condition: ContactFilterCondition,
  today: RawBuilder<unknown>,
): Test {
  const days = condition.days ?? 0;
  switch (operatorFor(contactFilterKinds.date, condition)) {
    case 'is':
      return sql`${column} = ${day('value', one(condition))}::date`;
    case 'is_not':
      return sql`${column} is distinct from ${day('value', one(condition))}::date`;
    case 'before':
      return sql`${column} < ${day('value', one(condition))}::date`;
    case 'after':
      return sql`${column} > ${day('value', one(condition))}::date`;
    case 'between':
      return sql`(${column} >= ${day('from', condition.from ?? '')}::date and ${column} <= ${day('to', condition.to ?? '')}::date)`;
    case 'in_last':
      return sql`(${column} >= ${today} - ${days}::integer and ${column} <= ${today})`;
    case 'not_in_last':
      return sql`${column} < ${today} - ${days}::integer`;
    case 'in_next':
      return sql`(${column} > ${today} and ${column} <= ${today} + ${days}::integer)`;
    case 'is_empty':
      return sql`${column} is null`;
    case 'is_not_empty':
      return sql`${column} is not null`;
  }
}

function numberTest(column: RawBuilder<unknown>, condition: ContactFilterCondition): Test {
  const value = () => sql`${amount('value', one(condition))}::numeric`;
  switch (operatorFor(contactFilterKinds.number, condition)) {
    case 'is':
      return sql`${column} = ${value()}`;
    case 'is_not':
      return sql`${column} is distinct from ${value()}`;
    case 'gt':
      return sql`${column} > ${value()}`;
    case 'gte':
      return sql`${column} >= ${value()}`;
    case 'lt':
      return sql`${column} < ${value()}`;
    case 'lte':
      return sql`${column} <= ${value()}`;
    case 'between':
      return sql`(${column} >= ${amount('from', condition.from ?? '')}::numeric and ${column} <= ${amount('to', condition.to ?? '')}::numeric)`;
    case 'is_empty':
      return sql`${column} is null`;
    case 'is_not_empty':
      return sql`${column} is not null`;
  }
}

/** A test of a column that holds one of a fixed list of names. */
function choiceTest(
  column: RawBuilder<unknown>,
  condition: ContactFilterCondition,
  known: readonly string[],
): Test {
  for (const [index, value] of many(condition).entries())
    if (!known.includes(value))
      refuse(`values/${String(index)}`, 'unknown_choice', `Choose one of ${known.join(', ')}.`);
  switch (operatorFor(contactFilterKinds.choice, condition)) {
    case 'any_of':
      return sql`${column} = any(${[...many(condition)]}::text[])`;
    case 'none_of':
      return sql`(${column} is null or ${column} <> all(${[...many(condition)]}::text[]))`;
    case 'is_empty':
      return sql`${column} is null`;
    case 'is_not_empty':
      return sql`${column} is not null`;
  }
}

/**
 * What email verification found of the contact's primary address, as a semi-join on the
 * primary addresses of the business (none_of as an anti-join), so the planner can read the
 * matching contacts in one pass rather than look each contact up. A contact without an
 * address is empty, and passes none_of.
 */
function emailVerificationTest(plan: Plan, condition: ContactFilterCondition): Test {
  for (const [index, value] of many(condition).entries())
    if (!(contactEmailVerifications as readonly string[]).includes(value))
      refuse(
        `values/${String(index)}`,
        'unknown_choice',
        `Choose one of ${contactEmailVerifications.join(', ')}.`,
      );
  const operator = operatorFor(contactFilterKinds.choice, condition);
  const primary = (test: Test) => sql<SqlBool>`exists (select 1 from crm.contact_identities i
      left join messaging.email_verifications v
        on v.business_id = i.business_id and v.address_normalized = i.value_normalized
      where i.business_id = ${plan.businessId} and i.contact_id = c.id
        and i.kind = 'email' and i.is_primary and ${test})`;
  const among = sql<SqlBool>`${primaryEmailState} = any(${[...many(condition)]}::text[])`;
  switch (operator) {
    case 'any_of':
      return primary(among);
    case 'none_of':
      return sql`not ${primary(among)}`;
    case 'is_empty':
      return sql`not ${primary(sql`true`)}`;
    case 'is_not_empty':
      return primary(sql`true`);
  }
}

interface Plan {
  readonly trx: DatabaseTransaction;
  readonly context: TenantContext;
  readonly businessId: string;
  readonly people: FilterPeople | undefined;
  readonly today: RawBuilder<unknown>;
}

async function tagTest(plan: Plan, condition: ContactFilterCondition): Promise<Test> {
  const tagged = (test: Test): Test =>
    sql`exists (select 1 from crm.record_tags rt
      where rt.business_id = c.business_id and rt.record_id = c.id and ${test})`;
  if (condition.operator === 'is_empty') return sql`not ${tagged(sql`true`)}`;
  if (condition.operator === 'is_not_empty') return tagged(sql`true`);
  const ids = many(condition).map(
    (value, index) =>
      parsePublicId('tag', value) ??
      refuse(`values/${String(index)}`, 'unknown_tag', 'Choose a tag of this business.'),
  );
  const known = await plan.trx
    .selectFrom('crm.tags')
    .select('id')
    .where('business_id', '=', plan.businessId)
    .where('id', 'in', ids)
    .execute();
  const have = new Set(known.map((row) => row.id));
  ids.forEach((id, index) => {
    if (!have.has(id))
      refuse(`values/${String(index)}`, 'unknown_tag', 'Choose a tag of this business.');
  });
  const unique = [...new Set(ids)];
  if (condition.operator === 'all_of')
    return sql`(${sql.join(
      unique.map((id) => tagged(sql`rt.tag_id = ${id}`)),
      sql` and `,
    )})`;
  const any = tagged(sql`rt.tag_id = any(${unique}::uuid[])`);
  return condition.operator === 'none_of' ? sql`not ${any}` : any;
}

async function ownerTest(plan: Plan, condition: ContactFilterCondition): Promise<Test> {
  if (condition.operator === 'is_empty') return sql`c.owner_user_id is null`;
  if (condition.operator === 'is_not_empty') return sql`c.owner_user_id is not null`;
  const { people } = plan;
  if (people === undefined)
    return refuse('field', 'unavailable_field', 'Contacts cannot be filtered by owner here.');
  const users: string[] = [];
  for (const [index, selection] of many(condition).entries()) {
    let userId: string | null;
    try {
      userId = await people.assignees.resolve(plan.trx, plan.context, selection);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      userId = null;
    }
    users.push(
      userId ??
        refuse(
          `values/${String(index)}`,
          'unavailable_member',
          'Choose someone on this business or agency team.',
        ),
    );
  }
  return condition.operator === 'none_of'
    ? sql`(c.owner_user_id is null or c.owner_user_id <> all(${users}::uuid[]))`
    : sql`c.owner_user_id = any(${users}::uuid[])`;
}

/** The digits of a phone number as written, without a national trunk zero. */
const phoneDigits = (value: string): string => value.replace(/\D/g, '').replace(/^0+/, '');

/**
 * A number is kept in E.164 and written in national form. "Is" and its kin compare whole
 * numbers: each value is read as the business's country reads it (0712 345678 is
 * +254712345678 in Kenya), and one that is no number is refused, so "is 1" never means
 * every +1 number. "Contains" looks for the digits anywhere.
 */
async function phoneTest(
  plan: Plan,
  rows: (test: Test) => Test,
  condition: ContactFilterCondition,
): Promise<Test> {
  if (condition.operator === 'contains' || condition.operator === 'not_contains')
    return anyRowTest(rows, sql`i.value_normalized`, condition, phoneDigits);
  if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty')
    return anyRowTest(rows, sql`i.value_normalized`, condition);
  const country = await countryOf(plan.trx, plan.businessId);
  const number = (member: string) => (value: string) => {
    const normalized = normalizePhone(value, country);
    return typeof normalized === 'string'
      ? normalized
      : refuse(member, 'phone_invalid', 'Enter a whole phone number, such as +1 212 555 0142.');
  };
  return anyRowTest(rows, sql`i.value_normalized`, {
    ...condition,
    ...(condition.value === undefined ? {} : { value: number('value')(condition.value) }),
    ...(condition.values === undefined
      ? {}
      : {
          values: condition.values.map((value, index) => number(`values/${String(index)}`)(value)),
        }),
  });
}

function builtInTest(
  plan: Plan,
  field: ContactFilterField,
  condition: ContactFilterCondition,
): Test | Promise<Test> {
  const identities = (kind: 'email' | 'phone') => (test: Test) =>
    sql<SqlBool>`exists (select 1 from crm.contact_identities i
      where i.business_id = c.business_id and i.contact_id = c.id
        and i.kind = ${kind} and ${test})`;
  switch (field) {
    case 'firstName':
      return textTest(sql`c.first_name`, condition);
    case 'lastName':
      return textTest(sql`c.last_name`, condition);
    case 'name':
      return textTest(sql`c.display_name`, condition);
    case 'timezone':
      return textTest(sql`c.timezone`, condition);
    case 'source':
      return textTest(sql`c.source`, condition);
    case 'email':
      return anyRowTest(identities('email'), sql`i.value_normalized`, condition);
    case 'phone':
      return phoneTest(plan, identities('phone'), condition);
    case 'company':
      return anyRowTest(
        (test) => sql<SqlBool>`exists (select 1 from crm.record_links link
          join crm.link_types link_type
            on link_type.business_id = link.business_id and link_type.id = link.link_type_id
          join crm.companies company
            on company.business_id = link.business_id and company.id = link.to_record_id
          where link.business_id = c.business_id and link.from_record_id = c.id
            and link.is_primary and link_type.key = 'contact_company'
            and company.deleted_at is null and ${test})`,
        sql`company.name`,
        condition,
      );
    case 'created':
      return momentTest(sql`c.created_at`, condition);
    case 'updated':
      return momentTest(sql`c.updated_at`, condition);
    case 'dateOfBirth':
      return dateTest(sql`c.date_of_birth`, condition, plan.today);
    case 'tags':
      return tagTest(plan, condition);
    case 'owner':
      return ownerTest(plan, condition);
    case 'type':
      return choiceTest(sql`c.contact_type`, condition, contactTypes);
    case 'createdSource':
      return choiceTest(sql`c.created_source`, condition, contactSources);
    // What email verification found of the primary address; empty is no address.
    case 'emailVerification':
      return emailVerificationTest(plan, condition);
    case 'dnd': {
      const channel = one(condition);
      const on =
        channel === 'all'
          ? sql<SqlBool>`c.do_not_contact`
          : sql<SqlBool>`c.dnd_channels @> array[${channel}]::text[]`;
      return condition.operator === 'enabled' ? on : sql`not ${on}`;
    }
  }
}

const customKinds: Readonly<Record<string, Exclude<ContactFilterKind, 'tags' | 'people' | 'dnd'>>> =
  {
    text: 'text',
    long_text: 'text',
    email: 'text',
    phone: 'text',
    url: 'text',
    number: 'number',
    money: 'number',
    date: 'date',
    datetime: 'moment',
    boolean: 'boolean',
    single_choice: 'choice',
    multi_choice: 'choice',
  };

async function customTest(plan: Plan, condition: ContactFilterCondition): Promise<Test> {
  const definition = await plan.trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.id', '=', 'f.object_type_id').onRef('o.business_id', '=', 'f.business_id'),
    )
    .select(['f.id', 'f.value_type', 'f.options'])
    .where('f.business_id', '=', plan.businessId)
    .where('f.id', '=', parsePublicId('field', condition.field) ?? '')
    .where('o.kind', '=', 'contact')
    .where('f.merged_into_field_id', 'is', null)
    .executeTakeFirst();
  if (definition === undefined)
    return refuse('field', 'unknown_field', 'Choose a field of contacts in this business.');
  const kind = customKinds[definition.value_type];
  // A text box list and a file upload field have no one value to compare: whether they
  // are set is all a filter asks of them.
  const allowed: readonly string[] =
    kind !== undefined
      ? contactFilterKinds[kind]
      : definition.value_type === 'text_list' || definition.value_type === 'file'
        ? ['is_empty', 'is_not_empty']
        : [];
  if (!allowed.includes(condition.operator))
    return refuse('operator', 'invalid_operator', 'This field cannot be compared this way.');
  const valued = (test: Test): Test =>
    sql`exists (select 1 from crm.field_values fv
      where fv.business_id = c.business_id and fv.record_id = c.id
        and fv.field_id = ${definition.id} and ${test})`;
  if (condition.operator === 'is_empty') return sql`not ${valued(sql`true`)}`;
  if (condition.operator === 'is_not_empty') return valued(sql`true`);
  // The dynamic field-kind lookup still needs a fail-closed fallback after presence checks.
  if (kind === undefined) return operatorFor([], condition);
  switch (kind) {
    case 'text':
      return anyRowTest(valued, sql`fv.value_text`, condition);
    case 'number':
      return condition.operator === 'is_not'
        ? sql`not ${valued(numberTest(sql`fv.value_number`, { ...condition, operator: 'is' }))}`
        : valued(numberTest(sql`fv.value_number`, condition));
    case 'date':
      return condition.operator === 'is_not'
        ? sql`not ${valued(dateTest(sql`fv.value_date`, { ...condition, operator: 'is' }, plan.today))}`
        : valued(dateTest(sql`fv.value_date`, condition, plan.today));
    case 'moment':
      return valued(momentTest(sql`fv.value_datetime`, condition));
    case 'boolean': {
      const value = one(condition);
      if (value !== 'true' && value !== 'false')
        return refuse('value', 'invalid_boolean', 'Give true or false.');
      return valued(sql`fv.value_bool = ${value === 'true'}`);
    }
    case 'choice': {
      const keys = optionKeys(definition.options);
      many(condition).forEach((value, index) => {
        if (!keys.includes(value))
          refuse(`values/${String(index)}`, 'unknown_choice', 'Choose one of the field’s choices.');
      });
      const any = valued(sql`fv.value_options && ${[...many(condition)]}::text[]`);
      return condition.operator === 'none_of' ? sql`not ${any}` : any;
    }
  }
}

/** The keys of a choice field's options, as crm.field_definitions.options holds them. */
function optionKeys(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) =>
    typeof option === 'object' &&
    option !== null &&
    'key' in option &&
    typeof option.key === 'string'
      ? [option.key]
      : [],
  );
}

const isBuiltIn = (field: string): field is ContactFilterField =>
  Object.hasOwn(contactFilterFields, field);

/**
 * The filter as one test of the contact `c`. Refuses, with pointers into `filter`, every
 * condition that names something this business does not have.
 */
export async function planContactFilter(
  trx: DatabaseTransaction,
  context: TenantContext,
  businessId: string,
  filter: ContactFilter,
  people?: FilterPeople,
): Promise<Test> {
  const plan: Plan = {
    trx,
    context,
    businessId,
    people,
    today: sql`(now() at time zone (select b.timezone from tenancy.businesses b where b.id = ${businessId}))::date`,
  };
  const issues: Issue[] = [];
  const groups: Test[] = [];
  for (const [groupIndex, group] of filter.groups.entries()) {
    const tests: Test[] = [];
    for (const [index, condition] of group.conditions.entries()) {
      try {
        tests.push(
          isBuiltIn(condition.field)
            ? await builtInTest(plan, condition.field, condition)
            : await customTest(plan, condition),
        );
      } catch (error) {
        if (!(error instanceof ConditionProblem)) throw error;
        issues.push({
          path: `/filter/groups/${String(groupIndex)}/conditions/${String(index)}/${error.member}`,
          code: error.code,
          message: error.message,
        });
      }
    }
    groups.push(sql`(${sql.join(tests, group.match === 'all' ? sql` and ` : sql` or `)})`);
  }
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return sql`(${sql.join(groups, filter.match === 'all' ? sql` and ` : sql` or `)})`;
}
