// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Company } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyEditPanel, { CompanyForm } from './company-panel';

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

// A busy machine (another lane's build, a two-core runner) answers late: wait longer for it.
configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
});
afterEach(cleanup);

const at = '2026-10-08T12:00:00.000Z';
const acme: Company = {
  id: 'com_01m4bd188ff82s0add91b7pz63',
  name: 'Acme Events',
  domain: 'acme.example',
  phone: '+254712345678',
  email: 'hello@acme.example',
  website: 'www.acme.example',
  address: '12 Harbour Road',
  city: 'Mombasa',
  state: 'Coast',
  postalCode: '80100',
  country: 'KE',
  description: 'Weddings by the sea.',
  createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
  trashedAt: null,
  createdAt: at,
  updatedAt: at,
  canManage: true,
};

function refusal(errors: { path: string; code: string; message: string }[]): ApiError {
  return new ApiError({
    type: 'about:blank',
    title: 'Validation failed',
    status: 422,
    detail: 'Correct the company.',
    errors,
  });
}

function show(company?: Company): {
  user: ReturnType<typeof userEvent.setup>;
  onSaved: ReturnType<typeof vi.fn<(saved: Company, another: boolean) => Promise<void>>>;
  onCancel: ReturnType<typeof vi.fn<() => void>>;
} {
  const onSaved = vi.fn<(saved: Company, another: boolean) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const onCancel = vi.fn<() => void>();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <CompanyForm company={company} onCancel={onCancel} onSaved={onSaved} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup({ delay: null }), onSaved, onCancel };
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;
const box = (name: string): HTMLElement => screen.getByRole('textbox', { name });

describe('the company panel', () => {
  it('adds a company with every field the API takes, and only once it has a name', async () => {
    server.answer = () => acme;
    const { user, onSaved } = show();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save and add another' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.type(box('Company Name'), 'Acme Events');
    expect(save).toHaveProperty('disabled', false);
    await user.type(box('Phone'), '+254712345678');
    await user.type(box('Email'), 'hello@acme.example');
    await user.type(box('Website'), 'www.acme.example');
    await user.type(box('Address'), '12 Harbour Road');
    await user.type(box('State'), 'Coast');
    await user.type(box('City'), 'Mombasa');
    await user.type(box('Description'), 'Weddings by the sea.');
    await user.type(box('Postal Code'), '80100');
    await user.click(screen.getByRole('combobox', { name: 'Country' }));
    await user.click(await screen.findByRole('option', { name: 'Kenya' }));
    await user.type(box('Domain'), 'acme.example');
    await user.click(save);
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(acme, false);
    });
    expect(inputOf('createCompany')).toEqual({
      body: {
        name: 'Acme Events',
        phone: '+254712345678',
        email: 'hello@acme.example',
        website: 'www.acme.example',
        address: '12 Harbour Road',
        city: 'Mombasa',
        state: 'Coast',
        postalCode: '80100',
        country: 'KE',
        description: 'Weddings by the sea.',
        domain: 'acme.example',
      },
    });
  });

  it('sends empty boxes as none, and can go on to another company', async () => {
    server.answer = () => acme;
    const { user, onSaved } = show();
    await user.type(box('Company Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Save and add another' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(acme, true);
    });
    expect(inputOf('createCompany')).toEqual({
      body: {
        name: 'Acme',
        phone: null,
        email: null,
        website: null,
        address: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        description: null,
        domain: null,
      },
    });
  });

  it("says what the API's own rules say under the field, without asking the server", async () => {
    const { user, onSaved } = show();
    await user.type(box('Company Name'), 'Acme');
    await user.type(box('Email'), 'hello');
    await user.type(box('Website'), 'ftp://acme.example');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Enter an email address, such as hello@acme.example.'),
    ).toBeTruthy();
    expect(screen.getByText('Enter a web address, such as www.acme.example.')).toBeTruthy();
    expect(box('Email').getAttribute('aria-invalid')).toBe('true');
    expect(server.calls).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    // Corrected, the draft goes.
    server.answer = () => acme;
    await user.clear(box('Email'));
    await user.clear(box('Website'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the server's refusals on their fields and keeps the draft", async () => {
    server.answer = () => {
      throw refusal([
        { path: '/domain', code: 'taken', message: 'Another company uses this domain.' },
        {
          path: '/country',
          code: 'invalid',
          message: 'Use a two-letter country code, such as KE.',
        },
        { path: '/phone', code: 'invalid', message: 'Enter a phone number.' },
      ]);
    };
    const { user, onSaved } = show();
    await user.type(box('Company Name'), 'Acme');
    await user.type(box('Domain'), 'acme.example');
    await user.type(box('Phone'), '12');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Another company uses this domain.')).toBeTruthy();
    expect(screen.getByText('Enter a phone number.')).toBeTruthy();
    const country = screen.getByRole('alert');
    expect(country.textContent).toBe('Use a two-letter country code, such as KE.');
    expect(screen.getByRole('combobox', { name: 'Country' }).getAttribute('aria-describedby')).toBe(
      country.id,
    );
    expect(box('Company Name')).toHaveProperty('value', 'Acme');
    expect(box('Domain')).toHaveProperty('value', 'acme.example');
    expect(onSaved).not.toHaveBeenCalled();
    // Choosing a country takes its refusal away.
    await user.click(screen.getByRole('combobox', { name: 'Country' }));
    await user.click(await screen.findByRole('option', { name: 'Kenya' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends the draft again when asked, though a refused field was left as it was', async () => {
    let refuse = true;
    server.answer = () => {
      if (!refuse) return acme;
      throw refusal([
        { path: '/domain', code: 'taken', message: 'Another company uses this domain.' },
        { path: '/phone', code: 'invalid', message: 'Enter a phone number.' },
      ]);
    };
    const { user, onSaved } = show();
    await user.type(box('Company Name'), 'Acme');
    await user.type(box('Domain'), 'acme.example');
    await user.type(box('Phone'), '0712 345678');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Another company uses this domain.')).toBeTruthy();
    // The keyboard goes to the first field refused, in the order the form shows them.
    expect(document.activeElement).toBe(box('Phone'));
    // One field is corrected; the other was fine all along (the domain was freed meanwhile).
    await user.type(box('Phone'), '9');
    expect(screen.queryByText('Enter a phone number.')).toBeNull();
    expect(screen.getByText('Another company uses this domain.')).toBeTruthy();
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(acme, false);
    });
    expect(server.calls).toHaveLength(2);
  });

  it('says why above the buttons when the refusal names no field, or nothing answered', async () => {
    server.answer = () => {
      throw new ApiError({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You need permission to manage companies.',
      });
    };
    const { user } = show();
    await user.type(box('Company Name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You need permission to manage companies.',
    );
    server.answer = () => {
      throw new TypeError('Failed to fetch');
    };
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        "The company wasn't saved. Check your connection and try again.",
      );
    });
  });

  it('edits a company from its own values, and clears what is emptied', async () => {
    server.answer = () => ({ ...acme, name: 'Acme Weddings' });
    const { user, onSaved, onCancel } = show(acme);
    expect(screen.queryByRole('button', { name: 'Save and add another' })).toBeNull();
    expect(box('Company Name')).toHaveProperty('value', 'Acme Events');
    expect(box('Email')).toHaveProperty('value', 'hello@acme.example');
    expect(box('Description')).toHaveProperty('value', 'Weddings by the sea.');
    expect(screen.getByRole('combobox', { name: 'Country' }).textContent).toBe('Kenya');
    await user.clear(box('Company Name'));
    await user.type(box('Company Name'), 'Acme Weddings');
    await user.clear(box('City'));
    await user.click(screen.getByRole('combobox', { name: 'Country' }));
    await user.click(await screen.findByRole('option', { name: 'No country' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({ ...acme, name: 'Acme Weddings' }, false);
    });
    expect(inputOf('updateCompany')).toEqual({
      params: { id: acme.id },
      body: {
        name: 'Acme Weddings',
        phone: '+254712345678',
        email: 'hello@acme.example',
        website: 'www.acme.example',
        address: '12 Harbour Road',
        city: null,
        state: 'Coast',
        postalCode: '80100',
        country: null,
        description: 'Weddings by the sea.',
        domain: 'acme.example',
      },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a saved country code that is not an assigned one, so saving does not lose it', async () => {
    server.answer = () => acme;
    const { user } = show({ ...acme, country: 'XK' });
    expect(screen.getByRole('combobox', { name: 'Country' }).textContent).toBe('Kosovo');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(inputOf('updateCompany')).toMatchObject({ body: { country: 'XK' } });
    });
  });

  it('says a company was just added when the form follows one', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider i18n={i18n}>
          <CompanyForm
            company={undefined}
            addedBefore
            onCancel={() => undefined}
            onSaved={() => Promise.resolve()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Company added. Add another, or close the panel.',
    );
  });

  it("is a whole panel for the company's own page: titled, holding the form, closed by Cancel", async () => {
    const onClose = vi.fn<() => void>();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider i18n={i18n}>
          <CompanyEditPanel
            company={acme}
            open
            returnFocus={{ current: null }}
            onClose={onClose}
            onSaved={() => Promise.resolve()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const panel = await screen.findByRole('dialog', { name: 'Edit company' });
    expect(within(panel).getByRole('textbox', { name: 'Company Name' })).toHaveProperty(
      'value',
      'Acme Events',
    );
    await userEvent
      .setup({ delay: null })
      .click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
