// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { SiteDomain, SiteRedirect } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainsPage } from './domains';

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
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
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

const at = '2026-10-11T09:00:00.000Z';
const goId = 'sdom_01h455vb4pex5vsknk084sn02q';
const rootId = 'sdom_01h455vb4pex5vsknk084sn02r';
const redirectId = 'srdr_01h455vb4pex5vsknk084sn02q';
const siteId = 'site_01h455vb4pex5vsknk084sn02q';

function domainOf(id: string, hostname: string, rest: Partial<SiteDomain> = {}): SiteDomain {
  return {
    id,
    hostname,
    record: { type: 'CNAME', host: 'go', value: 'sites.crm.example' },
    verification: { status: 'pending', error: null, checkedAt: null, verifiedAt: null },
    certificateStatus: 'none',
    wwwRedirect: false,
    defaultStepId: null,
    notFoundStepId: null,
    siteCount: 0,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}
const go = domainOf(goId, 'go.harborlights.example');
const root = domainOf(rootId, 'harborlights.example', {
  record: { type: 'A', host: '@', value: '203.0.113.10' },
  verification: { status: 'verified', error: null, checkedAt: at, verifiedAt: at },
  siteCount: 2,
  revision: 3,
});
const spring: SiteRedirect = {
  id: redirectId,
  domainId: goId,
  hostname: 'go.harborlights.example',
  path: '/spring',
  target: { type: 'url', url: 'https://example.com/spring' },
  status: 301,
  revision: 2,
  createdAt: at,
  updatedAt: at,
};

function refusal(
  status: number,
  rest: { detail?: string; errors?: { path: string; code: string; message: string }[] } = {},
) {
  return new ApiError({ type: 'about:blank', title: 'Refused', status, ...rest });
}

/** Answers the lists from what the test holds, and anything else as the test says. */
function serve(
  held: { domains?: SiteDomain[]; redirects?: SiteRedirect[]; canManage?: boolean },
  rest: (operation: string, input: unknown) => unknown = () => undefined,
): void {
  const canManage = held.canManage ?? true;
  server.answer = (operation, input) => {
    if (operation === 'listSiteDomains') return { items: held.domains ?? [], canManage };
    if (operation === 'listSiteRedirects') return { items: held.redirects ?? [], canManage };
    if (operation === 'listSites') {
      const { kind } = (input as { query: { kind: string } }).query;
      return {
        items: kind === 'funnel' ? [{ id: siteId, kind: 'funnel', name: 'Spring offer' }] : [],
        total: kind === 'funnel' ? 1 : 0,
        next: null,
        canManage,
      };
    }
    return rest(operation, input);
  };
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <DomainsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const sent = (operation: string): unknown[] =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);
const card = (hostname: string): Promise<HTMLElement> =>
  screen.findByRole('region', { name: hostname });

describe('the Domains view', () => {
  it('with no domain offers to connect one and links out to a registrar, and sells nothing', async () => {
    serve({});
    show();
    expect(await screen.findByRole('heading', { name: 'No domains connected yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect a domain' })).toBeTruthy();
    const link = screen.getByRole('link', { name: /Cloudflare Registrar/ });
    expect(link.getAttribute('href')).toBe('https://www.cloudflare.com/products/registrar/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByText(/purchase|transfer/i)).toBeNull();
  });

  it('shows each domain with its status, the record exactly as served, and its sites', async () => {
    serve({ domains: [go, root] });
    show();
    const pending = await card('go.harborlights.example');
    expect(within(pending).getByText('Pending')).toBeTruthy();
    expect(within(pending).getByText('Not linked to a funnel or website.')).toBeTruthy();
    expect(within(pending).getByText('Not checked yet.')).toBeTruthy();
    const record = within(pending).getByRole('group', { name: 'DNS record' });
    expect(record.textContent).toContain('TypeCNAMENamegoValuesites.crm.example');

    const verified = await card('harborlights.example');
    expect(within(verified).getByText('Verified')).toBeTruthy();
    expect(within(verified).getByText('Linked to 2 funnels and websites.')).toBeTruthy();
    expect(within(verified).getByRole('group', { name: 'DNS record' }).textContent).toContain(
      'TypeAName@Value203.0.113.10',
    );
  });

  it('copies a value of the record and says so', async () => {
    serve({ domains: [go] });
    const user = show();
    const pending = await card('go.harborlights.example');
    await user.click(within(pending).getByRole('button', { name: 'Copy value' }));
    expect(await screen.findByText('Copied sites.crm.example')).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe('sites.crm.example');
  });

  it('connects a domain: the schema refuses first, then the server on its box, then it is sent again', async () => {
    const held = { domains: [] as SiteDomain[] };
    let tries = 0;
    serve(held, (operation) => {
      if (operation !== 'createSiteDomain') return undefined;
      tries += 1;
      if (tries === 1) {
        throw refusal(422, {
          errors: [
            {
              path: '/hostname',
              code: 'taken',
              message: 'This domain is already connected, here or in another business.',
            },
          ],
        });
      }
      held.domains = [go];
      return go;
    });
    const user = show();
    await user.click(await screen.findByRole('button', { name: 'Connect a domain' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect a domain' });
    const box = within(dialog).getByLabelText('Domain');
    const connect = within(dialog).getByRole('button', { name: 'Connect' });
    expect(connect).toHaveProperty('disabled', true);

    await user.type(box, 'not a domain');
    await user.click(connect);
    expect(within(dialog).getByText('Enter a domain name, such as www.example.com.')).toBeTruthy();
    expect(sent('createSiteDomain')).toEqual([]);

    await user.clear(box);
    await user.type(box, ' GO.HarborLights.example ');
    await user.click(connect);
    expect(await within(dialog).findByText(/already connected/)).toBeTruthy();
    expect(box.getAttribute('aria-invalid')).toBe('true');

    // The refusal does not block the next try, with the box left as it was.
    await user.click(connect);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent('createSiteDomain')).toEqual([
      { body: { hostname: 'go.harborlights.example' } },
      { body: { hostname: 'go.harborlights.example' } },
    ]);
    expect(await card('go.harborlights.example')).toBeTruthy();
    expect(
      screen.getByText(
        'go.harborlights.example is connected. Add its DNS record, then press Check.',
      ),
    ).toBeTruthy();
  });

  it("checks a domain and shows the server's answer", async () => {
    const failed = {
      ...go,
      verification: {
        status: 'failed' as const,
        error: 'go.harborlights.example points at 198.51.100.7, not at this install.',
        checkedAt: at,
        verifiedAt: null,
      },
      revision: 2,
    };
    serve({ domains: [go] }, (operation) =>
      operation === 'verifySiteDomain' ? failed : undefined,
    );
    const user = show();
    const pending = await card('go.harborlights.example');
    await user.click(within(pending).getByRole('button', { name: 'Check' }));
    expect(await within(pending).findByText('Failed')).toBeTruthy();
    expect(within(pending).getByText(/points at 198.51.100.7/)).toBeTruthy();
    expect(screen.getByText("go.harborlights.example isn't verified yet.")).toBeTruthy();
    expect(sent('verifySiteDomain')).toEqual([{ params: { id: goId } }]);
  });

  it('says plainly when the install has no sites address: no record, and a check is refused', async () => {
    serve({ domains: [{ ...go, record: null }] }, (operation) => {
      if (operation === 'verifySiteDomain') {
        throw refusal(409, { detail: 'This install has not been told where its sites answer.' });
      }
      return undefined;
    });
    const user = show();
    const pending = await card('go.harborlights.example');
    expect(
      within(pending).getByText(/sites address isn't set up yet, so there is no DNS record/),
    ).toBeTruthy();
    expect(within(pending).queryByRole('group', { name: 'DNS record' })).toBeNull();
    await user.click(within(pending).getByRole('button', { name: 'Check' }));
    expect((await within(pending).findByRole('alert')).textContent).toContain(
      "It wasn't checked: this install's sites address isn't set up yet.",
    );
  });

  it('turns the www redirect of a root domain on, with the revision it read', async () => {
    serve({ domains: [go, root] }, (operation) =>
      operation === 'updateSiteDomain' ? { ...root, wwwRedirect: true, revision: 4 } : undefined,
    );
    const user = show();
    const verified = await card('harborlights.example');
    expect(within(await card('go.harborlights.example')).queryByRole('checkbox')).toBeNull();
    const www = within(verified).getByRole('checkbox', { name: /Also answer at www\./ });
    await user.click(www);
    await waitFor(() => {
      expect(www).toHaveProperty('checked', true);
    });
    expect(sent('updateSiteDomain')).toEqual([
      { params: { id: rootId }, body: { revision: 3, wwwRedirect: true } },
    ]);
  });

  it('removes a domain after asking', async () => {
    const held = { domains: [go, root] };
    serve(held, (operation) => {
      if (operation === 'deleteSiteDomain') held.domains = [root];
      return undefined;
    });
    const user = show();
    await user.click(
      within(await card('go.harborlights.example')).getByRole('button', { name: 'Remove' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Remove domain' });
    expect(dialog.textContent).toContain(
      'go.harborlights.example and its redirects will be removed.',
    );
    expect(sent('deleteSiteDomain')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'go.harborlights.example' })).toBeNull();
    });
    expect(sent('deleteSiteDomain')).toEqual([{ params: { id: goId } }]);
    expect(screen.getByText('go.harborlights.example was removed.')).toBeTruthy();
  });

  it('someone who may only read sees the domains and no way to change them', async () => {
    serve({ domains: [go, root], canManage: false });
    show();
    const verified = await card('harborlights.example');
    expect(screen.getByText(/needs permission to manage domains/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect a domain' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(verified).getByRole('checkbox')).toHaveProperty('disabled', true);
  });

  it('a refusal to read says permission is needed', async () => {
    server.answer = () => {
      throw refusal(403);
    };
    show();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You need permission to manage domains.',
    );
  });
});

describe('the URL Redirects view', () => {
  async function open() {
    const user = show();
    await user.click(screen.getByRole('button', { name: 'URL Redirects' }));
    return user;
  }

  it('lists redirects by address, with where each goes and its type', async () => {
    serve({
      domains: [go],
      redirects: [
        spring,
        {
          ...spring,
          id: 'srdr_01h455vb4pex5vsknk084sn02r',
          path: '/offer',
          target: { type: 'site', siteId, siteName: 'Spring offer', siteKind: 'funnel' },
          status: 302,
        },
      ],
    });
    await open();
    const first = await screen.findByRole('row', { name: /go\.harborlights\.example\/spring/ });
    expect(first.textContent).toContain('https://example.com/spring');
    expect(first.textContent).toContain('Permanent (301)');
    const second = screen.getByRole('row', { name: /go\.harborlights\.example\/offer/ });
    expect(second.textContent).toContain('Spring offer (funnel)');
    expect(second.textContent).toContain('Temporary (302)');
  });

  it('with no domain sends the reader to connect one first', async () => {
    serve({});
    const user = await open();
    expect(await screen.findByText(/Connect a domain first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add redirect' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Go to Domains' }));
    expect(await screen.findByRole('heading', { name: 'No domains connected yet' })).toBeTruthy();
  });

  it('adds a redirect: a refusal goes under its box and does not block the next Save', async () => {
    const held = { domains: [go], redirects: [] as SiteRedirect[] };
    let tries = 0;
    serve(held, (operation) => {
      if (operation !== 'createSiteRedirect') return undefined;
      tries += 1;
      if (tries === 1) {
        throw refusal(422, {
          errors: [
            {
              path: '/path',
              code: 'taken',
              message: 'This domain already has a redirect at this path.',
            },
          ],
        });
      }
      held.redirects = [spring];
      return spring;
    });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add redirect' }));
    const dialog = screen.getByRole('dialog', { name: 'Add redirect' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    const path = within(dialog).getByLabelText('Path');
    expect(path).toHaveProperty('value', '/');

    await user.clear(path);
    await user.type(path, 'spring');
    await user.type(within(dialog).getByLabelText('Web address'), 'https://example.com/spring');
    await user.click(save);
    expect(
      within(dialog).getByText('Start the path with / and leave out any ? or #.'),
    ).toBeTruthy();
    expect(sent('createSiteRedirect')).toEqual([]);

    await user.clear(path);
    await user.type(path, '/spring');
    await user.click(save);
    expect(await within(dialog).findByText(/already has a redirect at this path/)).toBeTruthy();
    expect(path.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(path);
    });

    await user.click(save);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const body = {
      domainId: goId,
      path: '/spring',
      target: { type: 'url', url: 'https://example.com/spring' },
      status: 301,
    };
    expect(sent('createSiteRedirect')).toEqual([{ body }, { body }]);
    expect(
      await screen.findByRole('row', { name: /go\.harborlights\.example\/spring/ }),
    ).toBeTruthy();
  });

  it('changes a redirect with its revision, keeping its domain; a stale one reloads', async () => {
    const newer = { ...spring, path: '/spring-2026', revision: 3 };
    const held = { domains: [go], redirects: [spring] };
    let tries = 0;
    serve(held, (operation) => {
      if (operation !== 'updateSiteRedirect') return undefined;
      tries += 1;
      if (tries === 1) {
        held.redirects = [newer];
        throw refusal(409, { detail: 'Someone else changed it first. Reload and try again.' });
      }
      return { ...newer, status: 302, revision: 4 };
    });
    const user = await open();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for go.harborlights.example/spring' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit redirect' });
    const path = within(dialog).getByLabelText('Path');
    expect(path).toHaveProperty('value', '/spring');
    expect(within(dialog).getByRole('combobox', { name: 'Domain' })).toHaveProperty(
      'disabled',
      true,
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Someone else changed it first/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Reload saved version' }));
    await waitFor(() => {
      expect(path).toHaveProperty('value', '/spring-2026');
    });

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const target = { type: 'url', url: 'https://example.com/spring' };
    expect(sent('updateSiteRedirect')).toEqual([
      { params: { id: redirectId }, body: { revision: 2, path: '/spring', target, status: 301 } },
      {
        params: { id: redirectId },
        body: { revision: 3, path: '/spring-2026', target, status: 301 },
      },
    ]);
  });

  it('deletes a redirect after asking', async () => {
    const held = { domains: [go], redirects: [spring] };
    serve(held, (operation) => {
      if (operation === 'deleteSiteRedirect') held.redirects = [];
      return undefined;
    });
    const user = await open();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for go.harborlights.example/spring' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete redirect' });
    expect(dialog.textContent).toContain('go.harborlights.example/spring will stop redirecting.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/No redirects yet/)).toBeTruthy();
    expect(sent('deleteSiteRedirect')).toEqual([{ params: { id: redirectId } }]);
  });

  it('someone who may only read sees the redirects and no way to change them', async () => {
    serve({ domains: [go], redirects: [spring], canManage: false });
    await open();
    expect(
      await screen.findByRole('row', { name: /go\.harborlights\.example\/spring/ }),
    ).toBeTruthy();
    expect(screen.getByText(/needs permission to manage domains/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add redirect' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });
});
