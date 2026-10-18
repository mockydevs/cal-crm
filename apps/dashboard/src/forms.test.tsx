// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  DEFAULT_FORM_DEFINITION,
  leadSources,
  updateFormInput,
  type Form,
  type FormDefinition,
  type FormSubmission,
  type FormSummary,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FormsPage } from './forms';

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
vi.mock('./shell/page', () => ({
  Page: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
  }: {
    children: ReactNode;
    params: { slug: string; contactId: string };
  }) => <a href={`/b/${params.slug}/contacts/${params.contactId}`}>{children}</a>,
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const ATTACK = '<img src=x onerror=alert(1)>';
const FORM_ID = 'form_01k8e2wzr0e008000000000001';
const SNIPPET = `<script async src="https://crm.example.test/forms/embed.js" data-form-key="${'k'.repeat(32)}"></script>`;
const formOf = (patch: Partial<Form> = {}): Form => ({
  id: FORM_ID,
  name: 'Wedding enquiry',
  status: 'draft',
  publicKey: 'k'.repeat(32),
  allowedOrigins: ['https://www.example.com'],
  definition: DEFAULT_FORM_DEFINITION,
  publishedDefinition: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  problems: [],
  embedSnippet: SNIPPET,
  hostedUrl: `https://crm.example.test/f/${'k'.repeat(32)}`,
  submissionCount: 0,
  revision: 'a'.repeat(64),
  canManage: true,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
  ...patch,
});
const summaryOf = (patch: Partial<FormSummary> = {}): FormSummary => ({
  id: FORM_ID,
  name: 'Wedding enquiry',
  status: 'draft',
  hasUnpublishedChanges: false,
  submissionCount: 0,
  lastSubmissionAt: null,
  updatedAt: '2026-10-10T09:00:00.000Z',
  ...patch,
});
const submissionOf = (patch: Partial<FormSubmission> = {}): FormSubmission => ({
  id: 'fsub_01k8e2wzr0e008000000000001',
  submittedAt: '2026-10-10T10:30:00.000Z',
  contactId: 'con_01k8e2wzr0e008000000000001',
  contactOutcome: 'created',
  answers: [
    { key: 'first_name', label: 'First name', value: 'Maya' },
    { key: 'email', label: 'Email', value: 'maya@example.test' },
  ],
  consents: [],
  terms: [],
  skippedFields: [],
  origin: 'https://www.example.com',
  pageUrl: 'https://www.example.com/enquire',
  ipAddress: '203.0.113.9',
  utm: {},
  leadSource: null,
  leadSourceRule: null,
  ...patch,
});
const problemOf = (
  status: number,
  detail: string,
  errors?: { path: string; code: string; message: string }[],
) =>
  new ApiError({
    type: 'about:blank',
    title: 'Refused',
    status,
    detail,
    ...(errors === undefined ? {} : { errors }),
  });

/** A stand-in API holding one form, which each change replaces as the real one does. */
function holding(initial: Form, more: Partial<Record<string, (input: unknown) => unknown>> = {}) {
  let current = initial;
  let revisions = 0;
  const next = (patch: Partial<Form>): Form => {
    revisions += 1;
    current = { ...current, ...patch, revision: String(revisions).padStart(64, 'b') };
    return current;
  };
  server.answer = (operation, input) => {
    const custom = more[operation];
    if (custom !== undefined) return custom(input);
    switch (operation) {
      case 'listForms':
        return { items: [summaryOf(current)], nextCursor: null, canManage: current.canManage };
      case 'getFields':
        return { items: [], objects: [], canManage: true };
      case 'getForm':
        return current;
      case 'updateForm': {
        const { body } = input as { body: unknown };
        const parsed = updateFormInput.parse(body);
        return next({
          name: parsed.name,
          definition: parsed.definition,
          allowedOrigins: parsed.allowedOrigins,
          hasUnpublishedChanges: current.status === 'published',
        });
      }
      case 'publishForm':
        return next({
          status: 'published',
          publishedDefinition: current.definition,
          publishedAt: '2026-10-10T11:00:00.000Z',
          hasUnpublishedChanges: false,
        });
      case 'unpublishForm':
        return next({ status: 'draft', publishedDefinition: null, publishedAt: null });
      case 'archiveForm':
        return next({ status: 'archived', publishedDefinition: null, publishedAt: null });
      case 'restoreForm':
        return next({ status: 'draft' });
      default:
        throw new Error(`Unexpected ${operation}`);
    }
  };
}

function open(): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <FormsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}
/**
 * Puts text at the end of a field as one paste. Typing it would be an event, a timer and a
 * render of the whole builder for every character, which is seconds for a form's worth of
 * words and no closer to what these tests are about.
 */
async function put(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
): Promise<void> {
  await user.click(field);
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
    field.setSelectionRange(field.value.length, field.value.length);
  await user.paste(text);
}
async function opened(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = open();
  await user.click(await screen.findByRole('button', { name: /^Open / }));
  await screen.findByRole('heading', { level: 2 });
  return user;
}
const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const bodyOf = (
  input: unknown,
): { name: string; definition: FormDefinition; allowedOrigins: string[]; revision: string } =>
  updateFormInput.parse((input as { body: unknown }).body);

it('lists forms with their state and what they have received, and shows names as text', async () => {
  server.answer = (operation, input) => {
    expect(operation).toBe('listForms');
    const { query } = input as { query: { archived: string } };
    return query.archived === 'true'
      ? {
          items: [summaryOf({ name: 'Old form', status: 'archived' })],
          nextCursor: null,
          canManage: true,
        }
      : {
          items: [
            summaryOf({
              name: ATTACK,
              status: 'published',
              submissionCount: 1,
              lastSubmissionAt: '2026-10-10T10:30:00.000Z',
            }),
            summaryOf({
              id: 'form_01k8e2wzr0e008000000000002',
              name: 'Newsletter',
              status: 'published',
              hasUnpublishedChanges: true,
              submissionCount: 12,
            }),
            summaryOf({ id: 'form_01k8e2wzr0e008000000000003', name: 'Not yet' }),
          ],
          nextCursor: null,
          canManage: true,
        };
  };
  const user = open();
  const list = await screen.findByRole('list', { name: 'Forms' });
  expect(list.querySelector('img, script')).toBeNull();
  const [first, second, third] = within(list).getAllByRole('listitem');
  if (first === undefined || second === undefined || third === undefined)
    throw new Error('Three forms.');
  expect(within(first).getByText(ATTACK)).toBeDefined();
  expect(within(first).getByText('Published')).toBeDefined();
  expect(first.textContent).toContain('1 submission');
  expect(first.textContent).toContain('last on');
  expect(within(second).getByText('Published, with changes not yet published')).toBeDefined();
  expect(second.textContent).toContain('12 submissions');
  expect(within(third).getByText('Draft')).toBeDefined();
  expect(third.textContent).toContain('No submissions yet');
  await user.click(screen.getByRole('button', { name: 'Show archived forms' }));
  const archived = await screen.findByRole('list', { name: 'Archived forms' });
  expect(within(archived).getByText('Archived')).toBeDefined();
  // No new form is added among the archived ones.
  expect(screen.queryByRole('button', { name: 'Add a form' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show forms in use' }));
  expect(await screen.findByRole('list', { name: 'Forms' })).toBeDefined();
});

it('says when there is nothing yet, offers another try when forms cannot be loaded, and no button to someone who only reads', async () => {
  let fail = true;
  server.answer = () => {
    if (fail) throw problemOf(503, 'Unavailable');
    return { items: [], nextCursor: null, canManage: false };
  };
  const user = open();
  expect(await screen.findByText("We couldn't load forms.")).toBeDefined();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No form yet. Add one to start building it.')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Add a form' })).toBeNull();
});

it('reads more forms a page at a time', async () => {
  server.answer = (_operation, input) => {
    const { query } = input as { query: { after?: string } };
    return query.after === undefined
      ? { items: [summaryOf()], nextCursor: FORM_ID, canManage: true }
      : {
          items: [summaryOf({ id: 'form_01k8e2wzr0e008000000000002', name: 'Second page' })],
          nextCursor: null,
          canManage: true,
        };
  };
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Show more forms' }));
  expect(await screen.findByText('Second page')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Show more forms' })).toBeNull();
});

it('adds a form by name, asks for a name first, and opens the builder on it', async () => {
  const made = formOf({ name: 'Open day' });
  server.answer = (operation) => {
    if (operation === 'listForms') return { items: [], nextCursor: null, canManage: true };
    if (operation === 'createForm') return made;
    if (operation === 'getForm') return made;
    return { items: [], objects: [], canManage: true };
  };
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Add a form' }));
  const name = screen.getByLabelText('Name of the new form');
  // The field appeared because its button was pressed: typing goes on there.
  expect(document.activeElement).toBe(name);
  await user.click(screen.getByRole('button', { name: 'Add the form' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Enter a name.');
  expect(callsTo('createForm')).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Name of the new form')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add a form' }));
  await put(user, screen.getByLabelText('Name of the new form'), '  Open day ');
  await user.click(screen.getByRole('button', { name: 'Add the form' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Open day' })).toBeDefined();
  expect(callsTo('createForm')).toEqual([{ body: { name: 'Open day' } }]);
  expect(callsTo('getForm')).toEqual([{ params: { id: FORM_ID } }]);
});

it('says why a form could not be added', async () => {
  server.answer = (operation) => {
    if (operation === 'listForms') return { items: [], nextCursor: null, canManage: true };
    throw operation === 'createForm'
      ? problemOf(403, "Your role doesn't allow this: it needs forms.manage.")
      : new Error('offline');
  };
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Add a form' }));
  await put(user, screen.getByLabelText('Name of the new form'), 'Open day');
  await user.click(screen.getByRole('button', { name: 'Add the form' }));
  expect(
    await screen.findByText("Your role doesn't allow this: it needs forms.manage."),
  ).toBeDefined();
  server.answer = (operation) => {
    if (operation === 'listForms') return { items: [], nextCursor: null, canManage: true };
    throw new Error('offline');
  };
  await user.click(screen.getByRole('button', { name: 'Add the form' }));
  expect(
    await screen.findByText("The form wasn't added. Check your connection and try again."),
  ).toBeDefined();
});

it("saves a form's name, websites and words exactly as written, and then has nothing left to save", async () => {
  holding(formOf());
  const user = await opened();
  // Nothing has changed yet, so there is nothing to save.
  expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', true);
  await user.clear(screen.getByLabelText('Name'));
  await put(user, screen.getByLabelText('Name'), 'Open day');
  await put(
    user,
    screen.getByLabelText('Websites that may show this form'),
    '\nhttps://shop.example.com',
  );
  await put(user, screen.getByLabelText('Heading'), 'Come and see us');
  await put(user, screen.getByLabelText('Introduction'), 'Two lines\nof text');
  await user.clear(screen.getByLabelText('Words on the button'));
  await put(user, screen.getByLabelText('Words on the button'), 'Book my place');
  expect(screen.getByText('Save your changes before publishing.')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(await screen.findByText('Saved.')).toBeDefined();
  const [sent] = callsTo('updateForm');
  expect((sent as { params: unknown }).params).toEqual({ id: FORM_ID });
  expect(bodyOf(sent)).toMatchObject({
    name: 'Open day',
    allowedOrigins: ['https://www.example.com', 'https://shop.example.com'],
    revision: 'a'.repeat(64),
    definition: {
      title: 'Come and see us',
      description: 'Two lines\nof text',
      submitLabel: 'Book my place',
      fields: DEFAULT_FORM_DEFINITION.fields,
      consents: [],
    },
  });
  // Saved: the heading is the new name, and there is nothing left to save.
  expect(screen.getByRole('heading', { level: 2, name: 'Open day' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', false);
});

it('adds, orders and removes questions and a consent box, each save from the revision before it', async () => {
  holding(formOf());
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Add a question' }));
  await user.clear(screen.getByLabelText('Question 3'));
  await put(user, screen.getByLabelText('Question 3'), 'How many guests?');
  await put(user, screen.getByLabelText('Hint under question 3'), 'Roughly.');
  await user.click(screen.getByLabelText('Question 3 must be answered'));
  // The new question first, the first name last.
  await user.click(screen.getByRole('button', { name: 'Move question 3 up' }));
  await user.click(screen.getByRole('button', { name: 'Move question 2 up' }));
  await user.click(screen.getByRole('button', { name: 'Move question 2 down' }));
  await user.click(screen.getByRole('button', { name: 'Add a consent box' }));
  await user.clear(screen.getByLabelText('Words beside consent box 1'));
  await put(user, screen.getByLabelText('Words beside consent box 1'), 'Email me about open days.');
  await user.click(screen.getByLabelText("The form can't be sent without consent box 1 ticked"));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(await screen.findByText('Saved.')).toBeDefined();
  const body = bodyOf(callsTo('updateForm')[0]);
  expect(body.revision).toBe('a'.repeat(64));
  expect(body.definition.consents).toEqual([
    { key: 'consent1', channel: 'email', wording: 'Email me about open days.', required: true },
  ]);
  expect(body.definition.fields.map((field) => [field.key, field.label, field.required])).toEqual([
    ['q1', 'How many guests?', true],
    ['email', 'Email', true],
    ['first_name', 'First name', false],
  ]);
  expect(body.definition.fields[0]).toMatchObject({
    helpText: 'Roughly.',
    type: 'text',
    target: { kind: 'none' },
  });
  await user.click(screen.getByRole('button', { name: 'Remove question 3' }));
  await user.click(screen.getByRole('button', { name: 'Remove consent box 1' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(2);
  });
  const second = bodyOf(callsTo('updateForm')[1]);
  // From the revision the first save answered with.
  expect(second.revision).toBe('1'.padStart(64, 'b'));
  expect(second.definition.fields.map((field) => field.key)).toEqual(['q1', 'email']);
  expect(second.definition.consents).toEqual([]);
});

it("checks a draft with the API's own rules before sending it, and marks the part that is wrong", async () => {
  holding(formOf());
  const user = await opened();
  await user.clear(screen.getByLabelText('Question 1'));
  await user.clear(screen.getByLabelText('Name'));
  await put(user, screen.getByLabelText('Websites that may show this form'), '\nexample.com/path');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Check the parts marked below.',
  );
  expect(callsTo('updateForm')).toEqual([]);
  const question = screen.getByRole('listitem', { name: /^Question 1:/ });
  expect(within(question).getByText('Give the question a label.')).toBeDefined();
  expect(screen.getByText('Enter a name.')).toBeDefined();
  const websites = screen.getByLabelText('Websites that may show this form');
  const described = (websites.getAttribute('aria-describedby') ?? '').split(' ');
  expect(described.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).toContain(
    'Enter a website address with nothing after the host',
  );
});

it('shows what the API says is wrong, by its part, and offers a reload when the form changed elsewhere', async () => {
  const fresh = formOf({ name: 'Changed elsewhere', revision: 'c'.repeat(64) });
  let attempt = 0;
  holding(formOf(), {
    updateForm: () => {
      attempt += 1;
      if (attempt === 1)
        throw problemOf(422, 'Check the form.', [
          {
            path: '/allowedOrigins/0',
            code: 'invalid_origin',
            message: 'Enter a secure website address, such as https://www.example.com.',
          },
          {
            path: '/definition/fields/1/label',
            code: 'too_big',
            message: 'Use at most 120 characters.',
          },
          {
            path: '/definition/consents/0/wording',
            code: 'too_small',
            message: 'Enter the wording of the box.',
          },
          { path: '', code: 'invalid', message: 'Something about the whole form.' },
        ]);
      if (attempt === 2)
        throw problemOf(409, 'This form changed since you opened it. Reload before saving.');
      throw new Error('offline');
    },
    getForm: () => (attempt >= 2 ? fresh : formOf()),
  });
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Add a consent box' }));
  await put(user, screen.getByLabelText('Heading'), 'Mine');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(
    await screen.findByText('Enter a secure website address, such as https://www.example.com.'),
  ).toBeDefined();
  expect(
    within(screen.getByRole('listitem', { name: 'Question 2: Email' })).getByText(
      'Use at most 120 characters.',
    ),
  ).toBeDefined();
  expect(screen.getByText('Enter the wording of the box.')).toBeDefined();
  expect(screen.getByText('Something about the whole form.')).toBeDefined();
  // What was typed is still there.
  expect(screen.getByLabelText('Heading')).toHaveProperty('value', 'Mine');

  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(
    await screen.findByText('This form changed since you opened it. Reload before saving.'),
  ).toBeDefined();
  expect(screen.getByLabelText('Heading')).toHaveProperty('value', 'Mine');
  await user.click(screen.getByRole('button', { name: 'Reload the saved form' }));
  expect(await screen.findByText('Reloaded. Your unsaved changes were replaced.')).toBeDefined();
  expect(screen.getByRole('heading', { level: 2, name: 'Changed elsewhere' })).toBeDefined();
  expect(screen.getByLabelText('Heading')).toHaveProperty('value', '');
  expect(screen.queryByRole('button', { name: 'Reload the saved form' })).toBeNull();

  await put(user, screen.getByLabelText('Heading'), 'Again');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(
    await screen.findByText("The form wasn't saved. Check your connection and try again."),
  ).toBeDefined();
});

it('publishes a saved draft with nothing wrong, gives the code for a website, and takes it down again', async () => {
  holding(formOf());
  const user = await opened();
  expect(screen.queryByText('Code for your website')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Publish' }));
  expect(await screen.findByText('Published. Websites now show this version.')).toBeDefined();
  expect(callsTo('publishForm')).toEqual([
    { params: { id: FORM_ID }, body: { revision: 'a'.repeat(64) } },
  ]);
  expect(screen.getByText('Published')).toBeDefined();
  // The code is shown as text, and copied as it is.
  const code = screen.getByRole('region', { name: 'Code for your website' });
  expect(within(code).getByText(SNIPPET)).toBeDefined();
  expect(code.querySelector('script')).toBeNull();
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await user.click(within(code).getByRole('button', { name: 'Copy the code' }));
  expect(writeText).toHaveBeenCalledWith(SNIPPET);
  expect(await within(code).findByText('Copied.')).toBeDefined();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.reject(new Error('denied')) },
    configurable: true,
  });
  await user.click(within(code).getByRole('button', { name: 'Copy the code' }));
  expect(
    await within(code).findByText("Couldn't copy. Select the code and copy it yourself."),
  ).toBeDefined();

  // Published with nothing new: nothing to publish. An edit, once saved, can be published.
  expect(screen.getByRole('button', { name: 'Publish changes' })).toHaveProperty('disabled', true);
  await put(user, screen.getByLabelText('Heading'), 'New heading');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(await screen.findByText('Published, with changes not yet published')).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Publish changes' }));
  expect(await screen.findByText('Published. Websites now show this version.')).toBeDefined();

  // Something typed and not saved survives taking the form down.
  await put(user, screen.getByLabelText('Introduction'), 'Not saved yet');
  await user.click(screen.getByRole('button', { name: 'Unpublish' }));
  expect(
    await screen.findByText('Unpublished. The form no longer accepts submissions.'),
  ).toBeDefined();
  expect(screen.getByLabelText('Introduction')).toHaveProperty('value', 'Not saved yet');
  await user.clear(screen.getByLabelText('Introduction'));
  expect(screen.queryByText('Code for your website')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Archive' }));
  expect(await screen.findByText('Archived.')).toBeDefined();
  // An archived form is read only until it is restored: its fields are in a disabled group.
  expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Restore as a draft' }));
  expect(await screen.findByText('Restored as a draft.')).toBeDefined();
  expect(screen.getByLabelText('Name').matches(':disabled')).toBe(false);
  expect(
    server.calls
      .map((call) => call.operation)
      .filter((operation) => operation.endsWith('Form') && operation !== 'getForm'),
  ).toEqual([
    'publishForm',
    'updateForm',
    'publishForm',
    'unpublishForm',
    'archiveForm',
    'restoreForm',
  ]);
});

it('says what stands between a draft and publishing, and marks what the API refuses when publishing', async () => {
  const blocked = formOf({
    allowedOrigins: [],
    problems: [
      {
        path: '/allowedOrigins',
        code: 'no_website',
        message: 'Add the website that will show this form.',
      },
      {
        path: '/fields/1/target',
        code: 'archived_field',
        message: 'This contact field is archived. Restore it or choose another.',
      },
    ],
  });
  holding(blocked);
  const user = await opened();
  expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);
  expect(screen.getByText('Before this form can be published')).toBeDefined();
  expect(screen.getAllByText('Add the website that will show this form.')).toHaveLength(2);
  expect(
    within(screen.getByRole('listitem', { name: 'Question 2: Email' })).getByText(
      'This contact field is archived. Restore it or choose another.',
    ),
  ).toBeDefined();
  cleanup();
  // A field archived between the read and the publish: the API refuses, and says where.
  holding(formOf(), {
    publishForm: () => {
      throw problemOf(422, 'Check the form.', [
        {
          path: '/fields/0/target',
          code: 'archived_field',
          message: 'This contact field is archived. Restore it or choose another.',
        },
      ]);
    },
  });
  await opened();
  await user.click(screen.getByRole('button', { name: 'Publish' }));
  expect(
    await within(screen.getByRole('listitem', { name: 'Question 1: First name' })).findByText(
      'This contact field is archived. Restore it or choose another.',
    ),
  ).toBeDefined();
  expect(screen.getByRole('alert').textContent).toContain('Check the parts marked below.');
});

it('lets someone who cannot manage forms read one, and change nothing', async () => {
  holding(
    formOf({ canManage: false, status: 'published', publishedDefinition: DEFAULT_FORM_DEFINITION }),
  );
  await opened();
  expect(
    screen.getByText('You can read this form. Changing it needs permission to manage forms.'),
  ).toBeDefined();
  expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);
  expect(screen.getByLabelText('Question 1').matches(':disabled')).toBe(true);
  for (const name of ['Save draft', 'Publish', 'Publish changes', 'Unpublish', 'Archive'])
    expect(screen.queryByRole('button', { name })).toBeNull();
  expect(screen.getByRole('button', { name: 'Add a question' }).matches(':disabled')).toBe(true);
});

it('previews the form as text, whatever its words contain', async () => {
  holding(
    formOf({
      definition: {
        ...DEFAULT_FORM_DEFINITION,
        title: ATTACK,
        description: `${ATTACK}\nsecond line`,
        submitLabel: ATTACK,
        fields: [
          {
            key: 'a',
            type: 'text',
            label: ATTACK,
            helpText: ATTACK,
            required: true,
            options: [],
            target: { kind: 'none' },
          },
          {
            key: 'b',
            type: 'single_choice',
            label: 'Venue',
            helpText: '',
            required: false,
            options: [{ key: 'x', label: ATTACK }],
            target: { kind: 'none' },
          },
          {
            key: 'c',
            type: 'checkbox',
            label: 'Terms',
            helpText: '',
            required: true,
            options: [],
            target: { kind: 'none' },
          },
          {
            key: 'd',
            type: 'long_text',
            label: 'Notes',
            helpText: '',
            required: false,
            options: [],
            target: { kind: 'none' },
          },
        ],
        consents: [{ key: 'news', channel: 'email', wording: ATTACK, required: true }],
      },
    }),
  );
  const user = await opened();
  const preview = screen.getByRole('region', { name: 'Preview' });
  expect(preview.querySelector('img, script')).toBeNull();
  // Title, introduction, the question, its hint, the choice, the box and the button.
  expect(within(preview).getAllByText(ATTACK, { exact: false }).length).toBeGreaterThanOrEqual(6);
  expect(preview.textContent).toContain('Terms (required)');
  expect(preview.textContent).toContain(`${ATTACK} (required)`);
  // Nothing in the preview can be filled in or sent.
  for (const box of within(preview).getAllByRole('checkbox'))
    expect(box).toHaveProperty('disabled', true);
  expect(within(preview).queryByRole('button')).toBeNull();
  expect(within(preview).queryByRole('textbox')).toBeNull();
  // It follows the draft as it is typed.
  await user.clear(screen.getByLabelText('Heading'));
  await put(user, screen.getByLabelText('Heading'), 'Typed just now');
  expect(within(preview).getByText('Typed just now')).toBeDefined();
  expect(document.querySelector('main img, main script')).toBeNull();
});

it('edits the choices of a choice question, each with a key of its own', async () => {
  holding(
    formOf({
      definition: {
        ...DEFAULT_FORM_DEFINITION,
        fields: [
          ...DEFAULT_FORM_DEFINITION.fields,
          {
            key: 'venue',
            type: 'single_choice',
            label: 'Venue',
            helpText: '',
            required: false,
            options: [{ key: 'harbor', label: 'Harbor room' }],
            target: { kind: 'none' },
          },
        ],
      },
    }),
  );
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Add a choice to question 3' }));
  await user.click(screen.getByRole('button', { name: 'Add a choice to question 3' }));
  await user.clear(screen.getByLabelText('Choice 2 of question 3'));
  await put(user, screen.getByLabelText('Choice 2 of question 3'), 'Garden');
  await user.click(screen.getByRole('button', { name: 'Remove choice 1 of question 3' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(1);
  });
  expect(bodyOf(callsTo('updateForm')[0]).definition.fields[2]?.options).toEqual([
    { key: 'new_choice', label: 'Garden' },
    { key: 'new_choice_1', label: 'New choice' },
  ]);
});

it('fills a visible question from the page address by a parameter name, and offers that to no kind that cannot take it', async () => {
  holding(
    formOf({
      definition: {
        ...DEFAULT_FORM_DEFINITION,
        fields: [
          ...DEFAULT_FORM_DEFINITION.fields,
          {
            key: 'interests',
            type: 'multi_choice',
            label: 'Interests',
            helpText: '',
            required: false,
            options: [{ key: 'a', label: 'A' }],
            target: { kind: 'none' },
          },
        ],
      },
    }),
  );
  const user = await opened();
  const box = screen.getByLabelText('Fill question 1 from the page address: parameter name');
  expect(box.getAttribute('aria-describedby')).not.toBeNull();
  // Several choices cannot be filled from one parameter: the box is not there.
  expect(
    screen.queryByLabelText('Fill question 3 from the page address: parameter name'),
  ).toBeNull();
  await put(user, box, 'first_name');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(1);
  });
  expect(bodyOf(callsTo('updateForm')[0]).definition.fields[0]?.parameter).toBe('first_name');
  expect(bodyOf(callsTo('updateForm')[0]).definition.fields[2]?.parameter).toBeUndefined();
});

const fieldOf = (id: string, label: string, valueType: string, options: string[] = []) => ({
  id,
  objectKey: 'contact',
  key: label.toLowerCase(),
  label,
  description: '',
  valueType,
  currency: null,
  options: options.map((key) => ({ key, label: key, description: '', archived: false })),
  aiFillSources: [],
  aiOverwrite: 'ask',
  archived: false,
  revision: 'a'.repeat(64),
});
const BUDGET = 'fld_01k8e2wzr0e008000000000001';
const VENUE = 'fld_01k8e2wzr0e008000000000002';
const GONE = 'fld_01k8e2wzr0e008000000000009';

it('chooses what kind of answer a question takes and where it is saved, from what fits', async () => {
  holding(
    formOf({
      definition: {
        ...DEFAULT_FORM_DEFINITION,
        fields: [
          ...DEFAULT_FORM_DEFINITION.fields,
          {
            key: 'old',
            type: 'text',
            label: 'Old question',
            helpText: '',
            required: false,
            options: [],
            target: { kind: 'field', fieldId: GONE },
          },
        ],
      },
    }),
    {
      getFields: () => ({
        items: [
          fieldOf(BUDGET, 'Budget', 'number'),
          fieldOf(VENUE, 'Venue', 'single_choice', ['harbor', 'garden']),
        ],
        objects: [],
        canManage: true,
      }),
    },
  );
  const user = await opened();
  const pick = async (label: string, option: string): Promise<void> => {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  };
  // A target that no longer exists is shown for what it is, not as nothing.
  expect(
    screen.getByRole('combobox', { name: 'Where the answer to question 3 is saved' }).textContent,
  ).toBe('A contact field that no longer exists');

  await user.click(screen.getByRole('button', { name: 'Add a question' }));
  await pick('Kind of answer for question 4', 'Number');
  await user.click(
    screen.getByRole('combobox', { name: 'Where the answer to question 4 is saved' }),
  );
  // Only what takes a number: no part of the contact does, one of its fields does.
  expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
    'Only kept with the submission',
    'Contact field: Budget',
  ]);
  await user.click(screen.getByRole('option', { name: 'Contact field: Budget' }));

  await user.click(screen.getByRole('button', { name: 'Add a question' }));
  await pick('Kind of answer for question 5', 'One choice from a list');
  await pick('Where the answer to question 5 is saved', 'Contact field: Venue');
  // The question takes the field's own choices, which are changed where the field is.
  const choice = screen.getByRole('listitem', { name: /^Question 5:/ });
  expect(within(choice).getByLabelText('Choice 1 of question 5')).toHaveProperty('value', 'harbor');
  expect(within(choice).getByLabelText('Choice 2 of question 5')).toHaveProperty('value', 'garden');
  expect(within(choice).queryByRole('button', { name: /^Remove choice/ })).toBeNull();
  expect(within(choice).queryByRole('button', { name: /^Add a choice/ })).toBeNull();
  expect(choice.textContent).toContain(
    'These are the choices of the contact field this question fills.',
  );

  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(1);
  });
  const { definition } = bodyOf(callsTo('updateForm')[0]);
  expect(definition.fields.map((field) => [field.key, field.type, field.target])).toEqual([
    ['first_name', 'text', { kind: 'contact', attribute: 'firstName' }],
    ['email', 'email', { kind: 'contact', attribute: 'email' }],
    ['old', 'text', { kind: 'field', fieldId: GONE }],
    ['q1', 'number', { kind: 'field', fieldId: BUDGET }],
    ['q2', 'single_choice', { kind: 'field', fieldId: VENUE }],
  ]);
  expect(definition.fields[4]?.options).toEqual([
    { key: 'harbor', label: 'harbor' },
    { key: 'garden', label: 'garden' },
  ]);
});

it('lets a hidden field fill a choice field, with its value when the page gives none picked from the choices', async () => {
  holding(formOf(), {
    getFields: () => ({
      items: [fieldOf(VENUE, 'Venue', 'single_choice', ['harbor', 'garden'])],
      objects: [],
      canManage: true,
    }),
  });
  const user = await opened();
  const pick = async (label: string, option: string): Promise<void> => {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  };
  await user.click(screen.getByRole('button', { name: 'Add a question' }));
  await pick('Kind of answer for question 3', 'Hidden field');
  await pick('Where the answer to question 3 is saved', 'Contact field: Venue');
  const fallback = 'Value for question 3 when the page gives none';
  await user.click(screen.getByRole('combobox', { name: fallback }));
  expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
    'No value',
    'harbor',
    'garden',
  ]);
  await user.click(screen.getByRole('option', { name: 'garden' }));
  // A hidden field reads utm_campaign until told otherwise.
  const parameter = screen.getByRole('textbox', { name: 'Page address parameter for question 3' });
  await user.clear(parameter);
  await user.type(parameter, 'venue');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(1);
  });
  const { definition } = bodyOf(callsTo('updateForm')[0]);
  expect(definition.fields[2]).toMatchObject({
    type: 'hidden',
    parameter: 'venue',
    defaultValue: 'garden',
    target: { kind: 'field', fieldId: VENUE },
  });
});

it('lets go of where an answer was saved when the kind of answer no longer fits it', async () => {
  holding(formOf());
  const user = await opened();
  const pick = async (label: string, option: string): Promise<void> => {
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: option }));
  };
  // The first name becomes a phone number: it can no longer fill the first name.
  await pick('Kind of answer for question 1', 'Phone number');
  await user.click(
    screen.getByRole('combobox', { name: 'Where the answer to question 1 is saved' }),
  );
  expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
    'Only kept with the submission',
    'Contact: phone number',
  ]);
  await user.click(screen.getByRole('option', { name: 'Contact: phone number' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(1);
  });
  const { definition } = bodyOf(callsTo('updateForm')[0]);
  expect(definition.fields.map((field) => [field.key, field.type, field.target])).toEqual([
    ['first_name', 'phone', { kind: 'contact', attribute: 'phone' }],
    ['email', 'email', { kind: 'contact', attribute: 'email' }],
  ]);
});

it('offers one consent box for each channel, and no third', async () => {
  holding(formOf());
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Add a consent box' }));
  await user.click(screen.getByRole('combobox', { name: 'What consent box 1 is for' }));
  await user.click(await screen.findByRole('option', { name: 'Marketing text messages' }));
  await user.click(screen.getByRole('button', { name: 'Add a consent box' }));
  // One box a channel: the second can only be for email, and there is no third.
  expect(screen.getByRole('combobox', { name: 'What consent box 2 is for' }).textContent).toBe(
    'Marketing email',
  );
  expect(screen.queryByRole('button', { name: 'Add a consent box' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => {
    expect(callsTo('updateForm')).toHaveLength(1);
  });
  const { definition } = bodyOf(callsTo('updateForm')[0]);
  expect(definition.consents.map((consent) => consent.channel)).toEqual(['sms', 'email']);
});

it('shows what people sent, as text, with the contact each reached and what became of its consent', async () => {
  const submissions = [
    submissionOf({
      answers: [
        { key: 'first_name', label: 'First name', value: ATTACK },
        { key: 'notes', label: ATTACK, value: 'Line one\nLine two' },
        { key: 'terms', label: 'Terms', value: true },
        { key: 'callback', label: 'Call me back', value: false },
        { key: 'phone', label: 'Phone', value: null },
      ],
      consents: [
        { key: 'news', channel: 'email', wording: 'Email me news.', outcome: 'granted' },
        { key: 'texts', channel: 'sms', wording: 'Text me.', outcome: 'no_address' },
      ],
      skippedFields: ['budget'],
      utm: { source: 'newsletter' },
      leadSource: 'Email',
      leadSourceRule: 'email',
    }),
    submissionOf({
      id: 'fsub_01k8e2wzr0e008000000000002',
      contactOutcome: 'updated',
      consents: [
        { key: 'news', channel: 'email', wording: 'Email me news.', outcome: 'withdrawn_kept' },
        { key: 'texts', channel: 'sms', wording: 'Text me.', outcome: 'not_ticked' },
      ],
      pageUrl: null,
      ipAddress: null,
    }),
  ];
  holding(formOf({ submissionCount: 2 }), {
    listFormSubmissions: (input) => {
      const { query } = input as { query: { after?: string } };
      return query.after === undefined
        ? { items: [submissions[0]], nextCursor: submissions[0]?.id, canManage: true }
        : { items: [submissions[1]], nextCursor: null, canManage: true };
    },
  });
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Submissions (2)' }));
  const list = await screen.findByRole('list', { name: 'Submissions, newest first' });
  expect(list.querySelector('img, script')).toBeNull();
  const [first] = within(list).getAllByRole('article');
  if (first === undefined) throw new Error('A submission.');
  expect(within(first).getAllByText(ATTACK)).toHaveLength(2);
  expect(within(first).getByText('Line one Line two', { collapseWhitespace: true })).toBeDefined();
  expect(within(first).getByText('Yes')).toBeDefined();
  expect(within(first).getByText('No')).toBeDefined();
  expect(within(first).getByText('No answer')).toBeDefined();
  expect(within(first).getByRole('link', { name: 'Open the new contact' })).toHaveProperty(
    'href',
    expect.stringContaining('/b/harbor/contacts/con_01k8e2wzr0e008000000000001') as string,
  );
  expect(within(first).getByText('Consent recorded')).toBeDefined();
  expect(
    within(first).getByText('Ticked, but there was no address or contact to record it for'),
  ).toBeDefined();
  expect(first.textContent).toContain('Some answers could not be written to the contact');
  expect(first.textContent).toContain(
    'https://www.example.com/enquire · source: newsletter · 203.0.113.9',
  );
  // How this person arrived, by the name the lead source rules gave it.
  expect(first.textContent).toContain('Lead sourceEmail');
  // Attached to a contact: it is the contact's, and cannot be discarded here.
  expect(within(first).queryByRole('button', { name: 'Discard…' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Show earlier submissions' }));
  await waitFor(() => {
    expect(within(list).getAllByRole('article')).toHaveLength(2);
  });
  const second = within(list).getAllByRole('article')[1];
  if (second === undefined) throw new Error('A second submission.');
  expect(within(second).getByRole('link', { name: 'Open the contact' })).toBeDefined();
  expect(
    within(second).getByText('Ticked, but this contact had withdrawn consent, so nothing changed'),
  ).toBeDefined();
  expect(within(second).getByText('Not ticked')).toBeDefined();
  expect(second.textContent).toContain('https://www.example.com');
  // One stored before lead sources were kept shows none.
  expect(second.textContent).not.toContain('Lead source');
  // The builder is still there on the way back, with what was typed.
  await user.click(screen.getByRole('button', { name: 'Build' }));
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Wedding enquiry');
});

it('narrows the submissions to one lead source, asked of the server by the rule’s key', async () => {
  const sent = [
    submissionOf({
      id: 'fsub_01k8e2wzr0e008000000000003',
      leadSource: 'Google Ads',
      leadSourceRule: 'google_ads',
    }),
    submissionOf({
      id: 'fsub_01k8e2wzr0e008000000000002',
      leadSource: 'Trade fair',
      leadSourceRule: 'source_param',
    }),
    submissionOf({
      id: 'fsub_01k8e2wzr0e008000000000001',
      leadSource: 'Direct',
      leadSourceRule: 'direct',
    }),
  ];
  holding(formOf({ submissionCount: 3 }), {
    listFormSubmissions: (input) => {
      const { query } = input as { query: { leadSourceRule?: string } };
      return {
        items: sent.filter(
          (each) =>
            query.leadSourceRule === undefined || each.leadSourceRule === query.leadSourceRule,
        ),
        nextCursor: null,
        canManage: true,
      };
    },
  });
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Submissions (3)' }));
  const shown = async (): Promise<string[]> =>
    within(await screen.findByRole('list', { name: 'Submissions, newest first' }))
      .getAllByRole('article')
      .map((card) => /Lead source(.*?)Open/u.exec(card.textContent)?.[1] ?? '');
  expect(await shown()).toEqual(['Google Ads', 'Trade fair', 'Direct']);
  // The choices are the contract's own names, then the one for a name a link chose.
  const filter = screen.getByRole('combobox', { name: 'Lead source' });
  expect(within(filter).getAllByRole('option')).toHaveLength(leadSources.length + 2);
  expect(
    within(filter)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual([
    'Every lead source',
    ...leadSources.map((each) => each.label),
    'Named by the link (source=…)',
  ]);

  await user.selectOptions(filter, 'Google Ads');
  await waitFor(async () => {
    expect(await shown()).toEqual(['Google Ads']);
  });
  expect(callsTo('listFormSubmissions').at(-1)).toEqual({
    params: { id: FORM_ID },
    query: { limit: 25, leadSourceRule: 'google_ads' },
  });
  await user.selectOptions(filter, 'Named by the link (source=…)');
  await waitFor(async () => {
    expect(await shown()).toEqual(['Trade fair']);
  });
  // None arrived that way: said in those words, not as a form nobody has sent.
  await user.selectOptions(filter, 'TikTok Ads');
  expect(await screen.findByText('No submission of this form arrived this way.')).toBeDefined();
  expect(screen.queryByText('Nobody has sent this form yet.')).toBeNull();
  await user.selectOptions(filter, 'Every lead source');
  await waitFor(async () => {
    expect(await shown()).toEqual(['Google Ads', 'Trade fair', 'Direct']);
  });
  expect(callsTo('listFormSubmissions').at(-1)).toEqual({
    params: { id: FORM_ID },
    query: { limit: 25 },
  });
});

it('lets a submission that reached no contact be discarded, after asking, and says when it could not be', async () => {
  let items = [
    submissionOf({
      contactId: null,
      contactOutcome: 'unresolved',
      consents: [],
      answers: [{ key: 'email', label: 'Email', value: 'trashed@example.test' }],
    }),
  ];
  let refuse = true;
  holding(formOf({ submissionCount: 1 }), {
    listFormSubmissions: () => ({ items, nextCursor: null, canManage: true }),
    discardFormSubmission: () => {
      if (refuse)
        throw problemOf(
          409,
          'This submission belongs to a contact. It is erased when the contact is.',
        );
      items = [];
      return undefined;
    },
  });
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Submissions (1)' }));
  const card = await screen.findByRole('article');
  expect(within(card).getByText('Not attached to a contact')).toBeDefined();
  expect(card.textContent).toContain(
    'These details match more than one contact, or a contact in the trash',
  );
  expect(within(card).queryByRole('link')).toBeNull();
  await user.click(within(card).getByRole('button', { name: 'Discard…' }));
  await user.click(within(card).getByRole('button', { name: 'Keep it' }));
  expect(callsTo('discardFormSubmission')).toEqual([]);
  await user.click(within(card).getByRole('button', { name: 'Discard…' }));
  await user.click(within(card).getByRole('button', { name: 'Discard it' }));
  expect(
    await within(card).findByText(
      'This submission belongs to a contact. It is erased when the contact is.',
    ),
  ).toBeDefined();
  refuse = false;
  await user.click(within(card).getByRole('button', { name: 'Discard it' }));
  expect(await screen.findByText('Nobody has sent this form yet.')).toBeDefined();
  expect(callsTo('discardFormSubmission')[0]).toEqual({
    params: { id: FORM_ID, submissionId: 'fsub_01k8e2wzr0e008000000000001' },
  });
});

it('shows no discard to someone who cannot manage forms, and offers another try when submissions cannot be loaded', async () => {
  let fail = true;
  holding(formOf({ canManage: false, submissionCount: 1 }), {
    listFormSubmissions: () => {
      if (fail) throw problemOf(503, 'Unavailable');
      return {
        items: [submissionOf({ contactId: null, contactOutcome: 'unresolved' })],
        nextCursor: null,
        canManage: false,
      };
    },
  });
  const user = await opened();
  await user.click(screen.getByRole('button', { name: 'Submissions (1)' }));
  expect(await screen.findByText("We couldn't load the submissions.")).toBeDefined();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  const card = await screen.findByRole('article');
  expect(within(card).queryByRole('button', { name: 'Discard…' })).toBeNull();
});

it('offers another try when a form cannot be opened, and goes back to the list', async () => {
  let fail = true;
  holding(formOf(), {
    getForm: () => {
      if (fail) throw problemOf(503, 'Unavailable');
      return formOf();
    },
  });
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Open Wedding enquiry' }));
  expect(await screen.findByText("We couldn't load this form.")).toBeDefined();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Wedding enquiry' })).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Back to all forms' }));
  expect(await screen.findByRole('list', { name: 'Forms' })).toBeDefined();
});

it('opens the form its address names, and tells the address which form to open and when to close it', async () => {
  holding(formOf());
  const onForm = vi.fn<(form: string | undefined) => void>();
  const page = (form?: string): ReactNode => (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <FormsPage form={form} onForm={onForm} />
      </I18nProvider>
    </QueryClientProvider>
  );
  const user = userEvent.setup({ delay: null });
  const { rerender } = render(page());
  await user.click(await screen.findByRole('button', { name: 'Open Wedding enquiry' }));
  expect(onForm).toHaveBeenLastCalledWith(FORM_ID);
  // The address has not changed yet, so the list is still what shows.
  expect(screen.getByRole('list', { name: 'Forms' })).toBeDefined();

  rerender(page(FORM_ID));
  expect(await screen.findByRole('heading', { level: 2, name: 'Wedding enquiry' })).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Back to all forms' }));
  expect(onForm).toHaveBeenLastCalledWith(undefined);
});

it('asks for bot protection only when chosen, and saves it with the definition', async () => {
  holding(formOf());
  const user = await opened();
  const protection = screen.getByRole('combobox', { name: 'Bot protection' });
  expect(protection.textContent).toContain('Off');
  await user.click(protection);
  await user.click(await screen.findByRole('option', { name: 'Proof of work (ALTCHA)' }));
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  expect(await screen.findByText('Saved.')).toBeDefined();
  expect(bodyOf(callsTo('updateForm')[0]).definition.botProtection).toBe('altcha');
});
