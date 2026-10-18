// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Contact, ContactDetails, RecordField } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ContactFields } from './contact-fields';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const at = '2026-10-08T12:00:00.000Z';
const contact: Contact = {
  id: 'con_01m4bd188ff82s0add91b7pz63',
  firstName: 'Maya',
  lastName: null,
  name: 'Maya',
  emails: ['maya@example.com', 'maya@work.example'],
  phones: [],
  timeZone: null,
  doNotContact: false,
  preferencesRevision: 'a'.repeat(64),
  trashedAt: null,
  createdAt: at,
  updatedAt: at,
  canManage: true,
};
const fieldOf = (label: string, value: RecordField['value']): RecordField => ({
  definition: {
    id: `fld_01m4bd188ff82s0add91b7pz6${String(label.length % 10)}`,
    objectKey: 'contact',
    key: label.toLowerCase(),
    label,
    description: `About ${label}.`,
    valueType: 'text',
    currency: null,
    options: [],
    aiFillSources: [],
    aiOverwrite: 'ask',
    archived: false,
    revision: 'a'.repeat(64),
  },
  value,
  source: value === null ? null : { kind: 'user', eventId: null, you: true },
  updatedAt: value === null ? null : at,
  confidence: null,
  confirmedAt: null,
  revision: 'b'.repeat(64),
});

const addressOf = (
  number: number,
  rest: Partial<ContactDetails['addresses'][number]>,
): ContactDetails['addresses'][number] => ({
  id: `cid_01m4bd188ff82s0add91b7pz6${String(number)}`,
  kind: 'phone',
  value: `+25471234567${String(number)}`,
  display: `0712 34567${String(number)}`,
  label: null,
  primary: false,
  delivery: { status: 'unchecked', reason: null, since: null },
  ...rest,
});
const detailsOf = (addresses: ContactDetails['addresses']): ContactDetails => ({
  id: contact.id,
  owner: null,
  ownerRevision: 'a'.repeat(64),
  followers: [],
  addresses,
  addressesRevision: 'a'.repeat(64),
  dnd: { all: false, channels: [], inbound: false, revision: 'a'.repeat(64) },
  createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
  createdSource: 'user',
  createdAt: at,
  canManage: true,
  canReadAudit: false,
});

function open(
  fields: readonly RecordField[] | Error,
  props: { readOnly?: boolean } = {},
  /** The contact's details; without them the server has none to give, as an older one. */
  details?: ContactDetails,
): ReturnType<typeof userEvent.setup> {
  let items = fields;
  let held = details;
  server.answer = (operation, input) => {
    if (operation === 'getContactDetails') {
      if (held === undefined) throw new Error('no details');
      return held;
    }
    if (operation === 'getContact') return contact;
    // An older server has no folders to give: the fields then show together.
    if (operation === 'listFieldFolders') throw new Error('no folders');
    if (held !== undefined && operation.endsWith('ContactAddress')) {
      const { params, body } = input as {
        params: { addressId?: string };
        body: { label?: 'mobile' | null; primary?: true; kind?: 'phone'; value?: string };
      };
      const addresses =
        operation === 'addContactAddress'
          ? [...held.addresses, addressOf(9, { display: body.value ?? '' })]
          : operation === 'removeContactAddress'
            ? held.addresses.filter((each) => each.id !== params.addressId)
            : held.addresses.map((each) =>
                each.id === params.addressId
                  ? { ...each, ...body }
                  : body.primary === true
                    ? { ...each, primary: false }
                    : each,
              );
      held = { ...held, addresses, addressesRevision: 'b'.repeat(64) };
      return held;
    }
    if (operation === 'setRecordField') {
      const { body } = input as { body: { value: RecordField['value'] } };
      const saved = { ...fieldOf('Venue', body.value), revision: 'c'.repeat(64) };
      if (!(items instanceof Error))
        items = items.map((field) => (field.definition.label === 'Venue' ? saved : field));
      return saved;
    }
    if (items instanceof Error) throw items;
    return { items, canManage: true, canConfirm: true };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <ContactFields contact={contact} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

it('shows each field as a label above its value, in groups, with -- where nothing is set', async () => {
  open([fieldOf('Venue', 'Garden'), fieldOf('Budget', null)]);
  const fields = screen.getByRole('region', { name: 'Fields' });
  const own = within(within(fields).getByRole('group', { name: 'Contact' }));
  expect(own.getByText('First name').nextElementSibling?.textContent).toBe('Maya');
  // An unset value is two dashes to look at, and "Not set" to hear.
  expect(own.getByText('Last name').nextElementSibling?.textContent).toBe('--Not set');
  expect(own.getByRole('link', { name: 'maya@example.com' }).getAttribute('href')).toBe(
    'mailto:maya@example.com',
  );
  expect(own.getByRole('link', { name: 'maya@work.example' })).toBeTruthy();
  expect(own.getByText('Phone').nextElementSibling?.textContent).toBe('--Not set');
  const more = within(await within(fields).findByRole('group', { name: 'Additional Info' }));
  expect(more.getByText('Venue').nextElementSibling?.textContent).toBe('Garden');
  expect(more.getByText('Budget').nextElementSibling?.textContent).toBe('--Not set');
});

it('closes and opens a group from its heading', async () => {
  const user = open([fieldOf('Venue', 'Garden')]);
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  await fields.findByText('Garden');
  const heading = fields.getByRole('button', { name: 'Additional Info' });
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  await user.click(heading);
  expect(heading.getAttribute('aria-expanded')).toBe('false');
  expect(fields.queryByText('Garden')).toBeNull();
  expect(fields.getByText('First name')).toBeTruthy();
  await user.click(heading);
  expect(fields.getByText('Garden')).toBeTruthy();
});

it('narrows the fields to what is searched for, and opens a closed group that matches', async () => {
  const user = open([fieldOf('Venue', 'Garden'), fieldOf('Budget', null)]);
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  await fields.findByText('Garden');
  await user.click(fields.getByRole('button', { name: 'Additional Info' }));
  await user.type(fields.getByRole('searchbox', { name: 'Search fields and folders' }), 'ven');
  expect(fields.getByText('Garden')).toBeTruthy();
  expect(fields.queryByText('Budget')).toBeNull();
  expect(fields.queryByRole('group', { name: 'Contact' })).toBeNull();
  await user.clear(fields.getByRole('searchbox', { name: 'Search fields and folders' }));
  await user.type(fields.getByRole('searchbox', { name: 'Search fields and folders' }), 'zzz');
  expect(fields.getByText('No fields match your search.')).toBeTruthy();
});

it('changes a value in place and shows what was saved', async () => {
  const user = open([fieldOf('Venue', 'Garden')]);
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  await user.click(await fields.findByRole('button', { name: 'Edit Venue' }));
  const input = fields.getByLabelText('Venue');
  await user.clear(input);
  await user.type(input, 'Rooftop');
  await user.click(fields.getByRole('button', { name: 'Save value' }));
  expect(await fields.findByText('Rooftop')).toBeTruthy();
  expect(server.calls.find((call) => call.operation === 'setRecordField')?.input).toMatchObject({
    body: { value: 'Rooftop', revision: 'b'.repeat(64) },
  });
  expect(fields.queryByRole('button', { name: 'Save value' })).toBeNull();
});

it('offers no change on a contact in the trash', async () => {
  open([fieldOf('Venue', 'Garden')], { readOnly: true });
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  await fields.findByText('Garden');
  expect(fields.queryByRole('button', { name: 'Edit Venue' })).toBeNull();
});

it("says so when the fields can't be read, beside the contact's own details", async () => {
  open(new Error('offline'));
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  expect((await fields.findByRole('alert')).textContent).toContain(
    "The fields couldn't be loaded.",
  );
  expect(fields.getByText('First name')).toBeTruthy();
  expect(fields.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it('shows each number with its label, the primary and a blocked address, to change in place', async () => {
  const user = open(
    [],
    {},
    detailsOf([
      addressOf(1, { primary: true, label: 'mobile' }),
      addressOf(2, { delivery: { status: 'blocked', reason: 'invalid', since: at } }),
    ]),
  );
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  const first = await fields.findByRole('link', { name: '0712 345671' });
  expect(first.getAttribute('href')).toBe('tel:+254712345671');
  expect(fields.getByText('Primary')).toBeTruthy();
  expect(fields.getByText('Blocked')).toBeTruthy();
  expect(fields.getByRole('combobox', { name: 'Label for 0712 345671' }).textContent).toBe(
    'Mobile',
  );
  // The primary number has no "Make primary"; the other one does.
  expect(fields.queryByRole('button', { name: 'Make 0712 345671 the primary' })).toBeNull();
  await user.click(fields.getByRole('button', { name: 'Make 0712 345672 the primary' }));
  await fields.findByRole('button', { name: 'Make 0712 345671 the primary' });
  expect(server.calls.find((call) => call.operation === 'updateContactAddress')?.input).toEqual({
    params: { id: contact.id, addressId: 'cid_01m4bd188ff82s0add91b7pz62' },
    body: { primary: true, revision: 'a'.repeat(64) },
  });

  await user.click(fields.getByRole('button', { name: 'Remove 0712 345671' }));
  expect(await fields.findByRole('link', { name: '0712 345672' })).toBeTruthy();
  expect(fields.queryByRole('link', { name: '0712 345671' })).toBeNull();
  // Each change names the revision the read before it gave.
  expect(server.calls.find((call) => call.operation === 'removeContactAddress')?.input).toEqual({
    params: { id: contact.id, addressId: 'cid_01m4bd188ff82s0add91b7pz61' },
    body: { revision: 'b'.repeat(64) },
  });
});

it('adds another number where the numbers are, and gives the keyboard back to the button', async () => {
  const user = open([], {}, detailsOf([addressOf(1, { primary: true })]));
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  await user.click(await fields.findByRole('button', { name: 'Add phone' }));
  const input = fields.getByRole('textbox', { name: 'New phone number' });
  expect(document.activeElement).toBe(input);
  await user.type(input, '0733 000111');
  await user.click(fields.getByRole('button', { name: 'Add' }));
  expect(await fields.findByRole('link', { name: '0733 000111' })).toBeTruthy();
  expect(server.calls.find((call) => call.operation === 'addContactAddress')?.input).toEqual({
    params: { id: contact.id },
    body: { kind: 'phone', value: '0733 000111' },
  });
  expect(document.activeElement).toBe(fields.getByRole('button', { name: 'Add phone' }));
});

it('shows a label and no way to change an address on a contact in the trash', async () => {
  open([], { readOnly: true }, detailsOf([addressOf(1, { primary: true, label: 'work' })]));
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  await fields.findByRole('link', { name: '0712 345671' });
  expect(fields.getByText('Work')).toBeTruthy();
  expect(fields.queryByRole('combobox')).toBeNull();
  expect(fields.queryByRole('button', { name: 'Add phone' })).toBeNull();
  expect(fields.queryByRole('button', { name: 'Remove 0712 345671' })).toBeNull();
});

it('shows the custom fields under the folder each is in, in the order of the folders', async () => {
  const inFolder = (field: RecordField, folderId: string): RecordField => ({
    ...field,
    definition: { ...field.definition, folderId },
  });
  const system = 'ffld_01m4bd188ff82s0add91b7pz61';
  const wedding = 'ffld_01m4bd188ff82s0add91b7pz62';
  open([
    inFolder(fieldOf('Venue', 'Garden'), wedding),
    inFolder(fieldOf('Budget', '9000'), system),
  ]);
  const fieldsOnly = server.answer;
  server.answer = (operation, input) =>
    operation === 'listFieldFolders'
      ? {
          canManage: true,
          items: [
            {
              id: system,
              objectKey: 'contact',
              name: 'Additional Info',
              system: true,
              position: 0,
            },
            { id: wedding, objectKey: 'contact', name: 'Wedding', system: false, position: 1 },
            {
              id: 'ffld_01m4bd188ff82s0add91b7pz63',
              objectKey: 'contact',
              name: 'Empty',
              system: false,
              position: 2,
            },
          ],
        }
      : fieldsOnly(operation, input);
  const fields = within(screen.getByRole('region', { name: 'Fields' }));
  expect(
    within(await fields.findByRole('group', { name: 'Wedding' })).getByText('Garden'),
  ).toBeTruthy();
  expect(
    within(fields.getByRole('group', { name: 'Additional Info' })).getByText('9000'),
  ).toBeTruthy();
  // A folder with none of this contact's fields has no section.
  expect(fields.queryByRole('group', { name: 'Empty' })).toBeNull();
  expect(server.calls.find((call) => call.operation === 'listFieldFolders')?.input).toEqual({
    query: { objectKey: 'contact' },
  });
});
