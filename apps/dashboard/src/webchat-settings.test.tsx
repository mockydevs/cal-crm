// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { WebchatWidget } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WebchatSettingsPage } from './webchat-settings';

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
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Bakery', slug: 'harbor' }),
}));
vi.mock('./shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const SNIPPET = (key: string): string =>
  `<script async src="https://crm.example.test/webchat/widget.js" data-widget-key="${key}"></script>`;
const widgetOf = (patch: Partial<WebchatWidget> = {}): WebchatWidget => ({
  id: 'wcw_01k8e2wzr0e008000000000001',
  name: 'Main site',
  publicKey: 'k'.repeat(32),
  enabled: true,
  allowedOrigins: ['https://example.com'],
  settings: {
    title: 'Chat with us',
    greeting: 'Hello. How can we help?',
    emailRequired: true,
    marketingConsentWording: null,
  },
  embedSnippet: SNIPPET('k'.repeat(32)),
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
  ...patch,
});

function open(): ReturnType<typeof userEvent.setup> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <WebchatSettingsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  // Keys follow one another with no timer between them (user-event's `delay`). Every key
  // is still its own events and its own render; what goes is a wait per character, which
  // on a busy machine took a long test past its five seconds.
  return userEvent.setup({ delay: null });
}
const callsTo = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const forbidden = (): ApiError =>
  new ApiError({
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    detail: "Your role doesn't allow this: it needs webchat.manage.",
  });

it('says who may manage web chat, and shows no control, to someone whose role does not', async () => {
  server.answer = () => {
    throw forbidden();
  };
  open();
  expect(await screen.findByText('You need permission to manage web chat.')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Add a chat widget' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('offers another try when the widgets cannot be loaded', async () => {
  let fail = true;
  server.answer = () => {
    if (fail) throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
    return { data: [] };
  };
  const user = open();
  expect(await screen.findByText("We couldn't load web chat.")).toBeDefined();
  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText('No chat widget yet. Add one to get the code for your website.'),
  ).toBeDefined();
});

it('shows a widget with its websites and its code as text, and copies the code', async () => {
  const hostile = widgetOf({
    name: '<img src=x onerror=alert(1)>',
    allowedOrigins: ['https://example.com', 'https://www.example.com'],
  });
  server.answer = () => ({ data: [hostile] });
  const user = open();
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const card = await screen.findByRole('region', { name: '<img src=x onerror=alert(1)>' });
  // The name and the code are characters on the page, never elements.
  expect(card.querySelector('img, script')).toBeNull();
  expect(within(card).getByText('On')).toBeDefined();
  expect(within(card).getByText('https://example.com')).toBeDefined();
  expect(within(card).getByText('https://www.example.com')).toBeDefined();
  expect(within(card).getByText(hostile.embedSnippet)).toBeDefined();
  await user.click(within(card).getByRole('button', { name: 'Copy the code' }));
  expect(writeText).toHaveBeenCalledWith(hostile.embedSnippet);
  expect(await within(card).findByText('Copied.')).toBeDefined();
});

it('says so when the code cannot be copied', async () => {
  server.answer = () => ({ data: [widgetOf()] });
  const user = open();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.reject(new Error('denied')) },
    configurable: true,
  });
  await user.click(await screen.findByRole('button', { name: 'Copy the code' }));
  expect(
    await screen.findByText("Couldn't copy. Select the code and copy it yourself."),
  ).toBeDefined();
});

it('warns that a widget with no website answers nowhere', async () => {
  server.answer = () => ({ data: [widgetOf({ allowedOrigins: [] })] });
  open();
  expect(
    await screen.findByText(/No website is listed, so this chat answers nowhere/),
  ).toBeDefined();
});

it('adds a widget: the websites one a line, no marketing box unless asked for', async () => {
  let stored: WebchatWidget[] = [];
  server.answer = (operation) => {
    if (operation === 'createWebchatWidget') {
      stored = [widgetOf({ name: 'Shop' })];
      return stored[0];
    }
    return { data: stored };
  };
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Add a chat widget' }));
  const form = screen.getByRole('region', { name: 'New chat widget' });
  expect(within(form).getByLabelText('Heading of the chat')).toHaveProperty(
    'value',
    'Chat with us',
  );
  expect(
    within(form).getByLabelText('Ask every visitor for an email address before they write'),
  ).toHaveProperty('checked', true);
  expect(
    within(form).getByLabelText('Offer visitors a box to tick for marketing email'),
  ).toHaveProperty('checked', false);
  expect(within(form).queryByLabelText('Words beside the box')).toBeNull();
  await user.type(within(form).getByLabelText('Name'), 'Shop');
  await user.type(
    within(form).getByLabelText('Websites that may show this chat'),
    ' https://example.com {Enter}{Enter}https://www.example.com',
  );
  await user.click(within(form).getByRole('button', { name: 'Add the widget' }));
  await waitFor(() => {
    expect(callsTo('createWebchatWidget')).toEqual([
      {
        body: {
          name: 'Shop',
          allowedOrigins: ['https://example.com', 'https://www.example.com'],
          enabled: true,
          settings: {
            title: 'Chat with us',
            greeting: 'Hello. How can we help?',
            emailRequired: true,
            marketingConsentWording: null,
          },
        },
      },
    ]);
  });
  // The form closes and the list is read again.
  expect(await screen.findByRole('region', { name: 'Shop' })).toBeDefined();
  expect(screen.queryByRole('region', { name: 'New chat widget' })).toBeNull();
});

it('checks the form before anything is sent, and says which website is wrong', async () => {
  server.answer = () => ({ data: [] });
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Add a chat widget' }));
  const form = screen.getByRole('region', { name: 'New chat widget' });
  await user.type(within(form).getByLabelText('Name'), 'Shop');
  await user.type(
    within(form).getByLabelText('Websites that may show this chat'),
    'https://example.com{Enter}https://*.example.com',
  );
  await user.click(within(form).getByLabelText('Offer visitors a box to tick for marketing email'));
  // A box that is offered needs its words: the browser itself asks for them.
  expect(within(form).getByLabelText('Words beside the box')).toHaveProperty('required', true);
  await user.type(within(form).getByLabelText('Words beside the box'), 'Email me news.');
  await user.click(within(form).getByRole('button', { name: 'Add the widget' }));
  expect(
    await within(form).findByText(
      'https://*.example.com: Enter a website address with nothing after the host, such as https://www.example.com.',
    ),
  ).toBeDefined();
  expect(callsTo('createWebchatWidget')).toEqual([]);
});

it("shows the server's own refusal of a website under the websites box", async () => {
  server.answer = (operation) => {
    if (operation !== 'createWebchatWidget') return { data: [] };
    throw new ApiError({
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      errors: [
        {
          path: '/allowedOrigins/0',
          code: 'invalid_origin',
          message: 'Enter a secure website address, such as https://www.example.com.',
        },
      ],
    });
  };
  const user = open();
  await user.click(await screen.findByRole('button', { name: 'Add a chat widget' }));
  const form = screen.getByRole('region', { name: 'New chat widget' });
  await user.type(within(form).getByLabelText('Name'), 'Shop');
  await user.type(
    within(form).getByLabelText('Websites that may show this chat'),
    'http://example.com',
  );
  await user.click(within(form).getByRole('button', { name: 'Add the widget' }));
  expect(
    await within(form).findByText(
      'http://example.com: Enter a secure website address, such as https://www.example.com.',
    ),
  ).toBeDefined();
  // Still open, with what was typed.
  expect(within(form).getByLabelText('Name')).toHaveProperty('value', 'Shop');
});

it('edits a widget and sends the whole of it, with the marketing wording when offered', async () => {
  let current = widgetOf();
  server.answer = (operation, input) => {
    if (operation === 'updateWebchatWidget') {
      const { body } = input as { body: Pick<WebchatWidget, 'name' | 'settings'> };
      current = { ...current, name: body.name, settings: body.settings };
      return current;
    }
    return { data: [current] };
  };
  const user = open();
  const card = await screen.findByRole('region', { name: 'Main site' });
  await user.click(within(card).getByRole('button', { name: 'Edit' }));
  const form = screen.getByRole('region', { name: 'Edit Main site' });
  expect(within(form).getByLabelText('Websites that may show this chat')).toHaveProperty(
    'value',
    'https://example.com',
  );
  await user.clear(within(form).getByLabelText('Name'));
  await user.type(within(form).getByLabelText('Name'), 'Bakery site');
  await user.click(within(form).getByLabelText('Offer visitors a box to tick for marketing email'));
  await user.type(within(form).getByLabelText('Words beside the box'), 'Email me news.');
  await user.click(within(form).getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(callsTo('updateWebchatWidget')).toEqual([
      {
        params: { id: current.id },
        body: {
          name: 'Bakery site',
          allowedOrigins: ['https://example.com'],
          enabled: true,
          settings: {
            title: 'Chat with us',
            greeting: 'Hello. How can we help?',
            emailRequired: true,
            marketingConsentWording: 'Email me news.',
          },
        },
      },
    ]);
  });
  expect(await screen.findByRole('region', { name: 'Bakery site' })).toBeDefined();
});

it('leaves a widget as it was when editing is cancelled', async () => {
  server.answer = () => ({ data: [widgetOf()] });
  const user = open();
  const card = await screen.findByRole('region', { name: 'Main site' });
  await user.click(within(card).getByRole('button', { name: 'Edit' }));
  const form = screen.getByRole('region', { name: 'Edit Main site' });
  await user.type(within(form).getByLabelText('Name'), ' changed');
  await user.click(within(form).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('region', { name: 'Main site' })).toBeDefined();
  expect(callsTo('updateWebchatWidget')).toEqual([]);
});

it('turns chat off and on with everything else unchanged', async () => {
  let current = widgetOf();
  server.answer = (operation, input) => {
    if (operation === 'updateWebchatWidget') {
      const { body } = input as { body: Pick<WebchatWidget, 'enabled'> };
      current = { ...current, enabled: body.enabled };
      return current;
    }
    return { data: [current] };
  };
  const user = open();
  const card = await screen.findByRole('region', { name: 'Main site' });
  await user.click(within(card).getByRole('button', { name: 'Turn chat off' }));
  expect(await screen.findByText('Chat is off.')).toBeDefined();
  expect(callsTo('updateWebchatWidget')).toEqual([
    {
      params: { id: current.id },
      body: {
        name: 'Main site',
        allowedOrigins: ['https://example.com'],
        enabled: false,
        settings: current.settings,
      },
    },
  ]);
  const off = await screen.findByRole('region', { name: 'Main site' });
  expect(await within(off).findByText('Off')).toBeDefined();
  await user.click(within(off).getByRole('button', { name: 'Turn chat on' }));
  expect(await screen.findByText('Chat is on.')).toBeDefined();
});

it('replaces a key only after saying what stops working, and shows the new code', async () => {
  let current = widgetOf();
  server.answer = (operation) => {
    if (operation === 'rotateWebchatWidgetKey') {
      current = { ...current, publicKey: 'n'.repeat(32), embedSnippet: SNIPPET('n'.repeat(32)) };
      return current;
    }
    return { data: [current] };
  };
  const user = open();
  const card = await screen.findByRole('region', { name: 'Main site' });
  await user.click(within(card).getByRole('button', { name: 'Replace key…' }));
  expect(
    within(card).getByText(/stops\s+working at once, and so does every chat that is open now/),
  ).toBeDefined();
  // Nothing happened yet, and it can be left.
  expect(callsTo('rotateWebchatWidgetKey')).toEqual([]);
  await user.click(within(card).getByRole('button', { name: 'Keep the key' }));
  expect(within(card).queryByRole('button', { name: 'Replace the key now' })).toBeNull();
  expect(callsTo('rotateWebchatWidgetKey')).toEqual([]);

  await user.click(within(card).getByRole('button', { name: 'Replace key…' }));
  await user.click(within(card).getByRole('button', { name: 'Replace the key now' }));
  expect(
    await screen.findByText('The key was replaced. Paste the new code into your website.'),
  ).toBeDefined();
  expect(callsTo('rotateWebchatWidgetKey')).toEqual([{ params: { id: current.id } }]);
  expect(await screen.findByText(SNIPPET('n'.repeat(32)))).toBeDefined();
  expect(screen.queryByText(SNIPPET('k'.repeat(32)))).toBeNull();
});

it('says so when a change is refused, and leaves the widget as it was', async () => {
  server.answer = (operation) => {
    if (operation === 'listWebchatWidgets') return { data: [widgetOf()] };
    throw forbidden();
  };
  const user = open();
  const card = await screen.findByRole('region', { name: 'Main site' });
  await user.click(within(card).getByRole('button', { name: 'Turn chat off' }));
  expect(
    await within(card).findByText("Your role doesn't allow this: it needs webchat.manage."),
  ).toBeDefined();
  expect(within(card).getByText('On')).toBeDefined();
});
