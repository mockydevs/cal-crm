// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { Company } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompaniesPage } from './companies-list';
import type { CompaniesSearch } from './company-search';

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
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ to, params, children }: { to: string; params: object; children: ReactNode }) => (
    <a href={`${to}#${Object.values(params).join('/')}`}>{children}</a>
  ),
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

function companyOf(number: number, name: string, rest: Partial<Company> = {}): Company {
  return {
    id: `com_${String(number)}`,
    name,
    domain: null,
    phone: null,
    email: null,
    website: null,
    address: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    description: null,
    createdBy: { kind: 'user', name: 'Lee Park', you: false },
    trashedAt: null,
    createdAt: at,
    updatedAt: at,
    canManage: true,
    ...rest,
  };
}

const acme = companyOf(1, 'Acme Events', {
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
  updatedAt: '2026-10-09T06:30:00.000Z',
});
const northwind = companyOf(2, 'Northwind', {
  createdBy: { kind: 'import', name: null, you: false },
});

function serve(
  companies: () => readonly Company[],
  on: (operation: string, input: unknown) => unknown = () => undefined,
  canManage = true,
): void {
  server.answer = (operation, input) => {
    const own = on(operation, input);
    if (own !== undefined) return own;
    if (operation === 'listCompanies')
      return { canManage, items: companies(), next: null, total: companies().length };
    if (operation === 'getFields') return { items: [] };
    return undefined;
  };
}

function Harness({ start }: { readonly start: CompaniesSearch }): ReactElement {
  const [search, setSearch] = useState(start);
  return <CompaniesPage search={search} onSearch={setSearch} />;
}

function show(start: CompaniesSearch = {}): ReturnType<typeof userEvent.setup> {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <Harness start={start} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}

const inputOf = (operation: string): unknown =>
  server.calls.findLast((call) => call.operation === operation)?.input;

async function rowOf(name: string): Promise<HTMLElement> {
  const row = (await screen.findByRole('rowheader', { name })).closest('tr');
  if (row === null) throw new Error('No row.');
  return row;
}

describe('the Companies page', () => {
  it("lists every company under GoHighLevel's columns, with how many there are", async () => {
    serve(() => [acme, northwind]);
    show();
    const row = await rowOf('Acme Events');
    expect(inputOf('listCompanies')).toEqual({ query: { limit: 20 } });
    expect(
      screen.getAllByRole('columnheader').map((heading) => heading.textContent.trim()),
    ).toEqual([
      'Company Name',
      'Phone',
      'Email',
      'Website',
      'Address',
      'State',
      'City',
      'Description',
      'Postal Code',
      'Country',
      'Created At',
      'Updated At',
      'Created By',
      'Actions',
    ]);
    expect(
      within(row)
        .getAllByRole('cell')
        .slice(0, 9)
        .map((cell) => cell.textContent),
    ).toEqual([
      '+254712345678',
      'hello@acme.example',
      'www.acme.example',
      '12 Harbour Road',
      'Coast',
      'Mombasa',
      'Weddings by the sea.',
      '80100',
      'Kenya',
    ]);
    expect([...row.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toEqual([
      at,
      '2026-10-09T06:30:00.000Z',
    ]);
    expect(within(row).getByText('You')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Acme Events' }).getAttribute('href')).toContain(
      'com_1',
    );
    expect(within(await rowOf('Northwind')).getByText('Import')).toBeTruthy();
    expect(screen.getByText('2 Companies')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Companies');
    expect(screen.getByRole('columnheader', { name: 'Created At' }).getAttribute('aria-sort')).toBe(
      'descending',
    );
  });

  it('asks the server for the order a heading names, each way, then newest first again', async () => {
    serve(() => [acme]);
    const user = show();
    await rowOf('Acme Events');
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({
        query: { sort: 'email', direction: 'asc', limit: 20 },
      });
    });
    expect(screen.getByRole('columnheader', { name: 'Email' }).getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(screen.getByRole('columnheader', { name: 'Created At' }).getAttribute('aria-sort')).toBe(
      'none',
    );
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({
        query: { sort: 'email', direction: 'desc', limit: 20 },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Created By' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({
        query: { sort: 'createdBy', direction: 'asc', limit: 20 },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Created By' }));
    await user.click(screen.getByRole('button', { name: 'Created By' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({ query: { limit: 20 } });
    });
  });

  it('searches once typing pauses, and says when nothing matches', async () => {
    serve(
      () => [acme],
      (operation, input) =>
        operation === 'listCompanies' && (input as { query: { q?: string } }).query.q === 'nobody'
          ? { canManage: true, items: [], next: null, total: 0 }
          : undefined,
    );
    const user = show({ sort: 'name' });
    await rowOf('Acme Events');
    await user.type(screen.getByRole('searchbox', { name: 'Search companies' }), 'nobody');
    expect(await screen.findByText('No companies match.')).toBeTruthy();
    expect(inputOf('listCompanies')).toEqual({
      query: { q: 'nobody', sort: 'name', direction: 'asc', limit: 20 },
    });
    expect(screen.getByText('0 Companies')).toBeTruthy();
    // One request for the finished word, none for its letters.
    expect(
      server.calls.filter(
        (call) =>
          call.operation === 'listCompanies' &&
          (call.input as { query: { q?: string } }).query.q !== undefined,
      ),
    ).toHaveLength(1);
  });

  it('turns pages on the cursor the server gave, and starts again at another size', async () => {
    const pages: Record<string, { items: Company[]; next: string | null }> = {
      first: { items: [acme], next: 'com_1' },
      com_1: { items: [northwind], next: null },
    };
    serve(
      () => [],
      (operation, input) => {
        if (operation !== 'listCompanies') return undefined;
        const after = (input as { query: { after?: string } }).query.after ?? 'first';
        return { canManage: true, total: 2, ...pages[after] };
      },
    );
    const user = show({ sort: 'name' });
    await rowOf('Acme Events');
    expect(screen.getByText('1 - 1 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await rowOf('Northwind');
    expect(inputOf('listCompanies')).toEqual({
      query: { sort: 'name', direction: 'asc', limit: 20, after: 'com_1' },
    });
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await rowOf('Acme Events');
    expect(inputOf('listCompanies')).toEqual({
      query: { sort: 'name', direction: 'asc', limit: 20 },
    });
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await rowOf('Northwind');
    await user.click(screen.getByRole('combobox', { name: 'Rows per page' }));
    await user.click(await screen.findByRole('option', { name: '50' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({
        query: { sort: 'name', direction: 'asc', limit: 50 },
      });
    });
  });

  it('goes back to the first page when the list changes', async () => {
    serve(
      () => [],
      (operation, input) => {
        if (operation !== 'listCompanies') return undefined;
        const after = (input as { query: { after?: string } }).query.after;
        return after === undefined
          ? { canManage: true, total: 2, items: [acme], next: 'com_1' }
          : { canManage: true, total: 2, items: [northwind], next: null };
      },
    );
    const user = show();
    await rowOf('Acme Events');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await rowOf('Northwind');
    await user.click(screen.getByRole('button', { name: 'Company Name' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({
        query: { sort: 'name', direction: 'asc', limit: 20 },
      });
    });
  });

  it('invites the first company when there are none', async () => {
    serve(() => []);
    show();
    expect(await screen.findByText('No Companies yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add Company' })).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('0 Companies')).toBeTruthy();
  });

  it('lets someone without the permission read, and offers them nothing to change', async () => {
    serve(() => [{ ...acme, canManage: false }], undefined, false);
    show();
    await rowOf('Acme Events');
    expect(screen.queryByRole('button', { name: 'Add Company' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Acme Events' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(
      screen.getByText(
        'You can read companies. Adding and changing them needs permission to manage companies.',
      ),
    ).toBeTruthy();
  });

  it('says so when the business does not let them see companies at all', async () => {
    serve(
      () => [],
      (operation) => {
        if (operation !== 'listCompanies') return undefined;
        throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
      },
    );
    show();
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You don't have permission to see this business's companies.",
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('keeps a failed list to itself and asks again on Try again', async () => {
    let failing = true;
    serve(
      () => [acme],
      (operation) => {
        if (operation !== 'listCompanies' || !failing) return undefined;
        throw new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503 });
      },
    );
    const user = show();
    // A fault is asked for twice more before it is shown.
    expect(
      await screen.findByText("The companies couldn't be loaded.", {}, { timeout: 15000 }),
    ).toBeTruthy();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await rowOf('Acme Events');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts again from the first page when the company a page was asked after is gone', async () => {
    serve(
      () => [],
      (operation, input) => {
        if (operation !== 'listCompanies') return undefined;
        if ((input as { query: { after?: string } }).query.after === undefined)
          return { canManage: true, total: 2, items: [acme], next: 'com_1' };
        throw new ApiError({
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          errors: [{ path: '/after', code: 'unknown_company', message: 'No such company.' }],
        });
      },
    );
    const user = show();
    await rowOf('Acme Events');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(inputOf('listCompanies')).toEqual({ query: { limit: 20 } });
    });
    await rowOf('Acme Events');
  });

  it('adds a company in the panel, reads the list again and says so', async () => {
    const listed = [acme];
    serve(
      () => listed,
      (operation) => {
        if (operation !== 'createCompany') return undefined;
        listed.push(northwind);
        return northwind;
      },
    );
    const user = show();
    await rowOf('Acme Events');
    await user.click(screen.getByRole('button', { name: 'Add Company' }));
    const panel = await screen.findByRole('dialog', { name: 'Add new Company' });
    await user.type(
      await within(panel).findByRole('textbox', { name: 'Company Name' }),
      'Northwind',
    );
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await rowOf('Northwind');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(inputOf('createCompany')).toMatchObject({ body: { name: 'Northwind', email: null } });
    expect(screen.getByText('Company added.')).toBeTruthy();
    expect(screen.getByText('2 Companies')).toBeTruthy();
  });

  it('keeps the panel open for the next company after "Save and add another"', async () => {
    serve(
      () => [acme],
      (operation) => (operation === 'createCompany' ? northwind : undefined),
    );
    const user = show();
    await rowOf('Acme Events');
    await user.click(screen.getByRole('button', { name: 'Add Company' }));
    const panel = await screen.findByRole('dialog', { name: 'Add new Company' });
    await user.type(
      await within(panel).findByRole('textbox', { name: 'Company Name' }),
      'Northwind',
    );
    await user.click(within(panel).getByRole('button', { name: 'Save and add another' }));
    expect(
      await within(panel).findByText('Company added. Add another, or close the panel.'),
    ).toBeTruthy();
    expect(within(panel).getByRole('textbox', { name: 'Company Name' })).toHaveProperty(
      'value',
      '',
    );
  });

  it('edits a company from its row in the same panel', async () => {
    serve(
      () => [acme],
      (operation) => (operation === 'updateCompany' ? { ...acme, city: 'Kilifi' } : undefined),
    );
    const user = show();
    const row = await rowOf('Acme Events');
    await user.click(within(row).getByRole('button', { name: 'Edit Acme Events' }));
    const panel = await screen.findByRole('dialog', { name: 'Edit company' });
    const city = await within(panel).findByRole('textbox', { name: 'City' });
    expect(city).toHaveProperty('value', 'Mombasa');
    await user.clear(city);
    await user.type(city, 'Kilifi');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(inputOf('updateCompany')).toMatchObject({
      params: { id: 'com_1' },
      body: { name: 'Acme Events', city: 'Kilifi', country: 'KE' },
    });
    expect(screen.getByText('Company saved.')).toBeTruthy();
  });
});
