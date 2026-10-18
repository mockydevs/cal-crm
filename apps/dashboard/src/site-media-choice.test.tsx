// @vitest-environment jsdom
// "Choose from Media Storage" for a site's page: a page keeps a file's public address, so
// a private file is made public first, and only after the person is told so.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { MediaFile } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import MediaChoice from './site-media-choice';

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
const shelf = vi.hoisted(() => ({ files: [] as MediaFile[], kinds: [] as unknown[] }));
// The library is tested where it is made (src/media): here it is its files as buttons.
vi.mock('./media/picker', () => ({
  default: ({
    kinds,
    onChoose,
    onClose,
  }: {
    kinds?: readonly string[];
    onChoose: (file: MediaFile) => void;
    onClose: () => void;
  }) => {
    shelf.kinds.push(kinds);
    return (
      <div role="dialog" aria-label="The library">
        {shelf.files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => {
              onChoose(file);
            }}
          >
            {file.name}
          </button>
        ))}
        <button type="button" onClick={onClose}>
          Close the library
        </button>
      </div>
    );
  },
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

const at = '2026-10-12T09:00:00.000Z';
const file = (rest: Partial<MediaFile> = {}): MediaFile => ({
  id: 'file_01h455vb4pex5vsknk084sn02q',
  name: 'storefront.jpg',
  contentType: 'image/jpeg',
  kind: 'image',
  size: 48_213,
  folderId: null,
  public: false,
  publicUrl: null,
  previewUrl: 'https://crm.example/m/p/file_1?sig=abc',
  createdAt: at,
  updatedAt: at,
  ...rest,
});
const address = 'https://crm.example/m/k4v9x2m7/storefront.jpg';

const chosen = vi.fn<(address: string, file: MediaFile) => void>();
const closed = vi.fn<() => void>();
let cache: QueryClient;

function show(): ReturnType<typeof userEvent.setup> {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={cache}>
        <MediaChoice
          businessId="biz_test"
          title="Choose a picture"
          onChosen={chosen}
          onClose={closed}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return userEvent.setup();
}

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls.length = 0;
  server.answer = () => undefined;
  shelf.kinds.length = 0;
  chosen.mockReset();
  closed.mockReset();
});
afterEach(cleanup);

describe('choosing a picture for a page from Media Storage', () => {
  it('shows pictures only, and hands on a public file’s public address at once', async () => {
    const open = file({ public: true, publicUrl: address });
    shelf.files = [open];
    const user = show();
    expect(shelf.kinds[0]).toEqual(['image']);
    await user.click(screen.getByRole('button', { name: 'storefront.jpg' }));
    expect(chosen).toHaveBeenCalledWith(address, open);
    // Never the signed preview link, which runs out in an hour.
    expect(chosen.mock.calls[0]?.[0]).not.toContain('sig=');
    expect(server.calls).toEqual([]);
  });

  it('tells the person a private file will be made public, and does it only when they agree', async () => {
    shelf.files = [file()];
    const user = show();
    await user.click(screen.getByRole('button', { name: 'storefront.jpg' }));
    const asked = await screen.findByRole('dialog', { name: 'Make "storefront.jpg" public?' });
    expect(asked.textContent).toContain(
      'A page needs a picture anyone can open. "storefront.jpg" is private now: using it makes it public',
    );
    expect(server.calls).toEqual([]);
    expect(chosen).not.toHaveBeenCalled();

    const saved = file({ public: true, publicUrl: address });
    server.answer = () => saved;
    const invalidated = vi.spyOn(cache, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    await waitFor(() => {
      expect(chosen).toHaveBeenCalledWith(address, saved);
    });
    expect(server.calls).toEqual([
      {
        operation: 'updateMediaFile',
        input: { params: { id: 'file_01h455vb4pex5vsknk084sn02q' }, body: { public: true } },
      },
    ]);
    // The library shows the file as public the next time it is opened.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['b', 'biz_test', 'media'] });
  });

  it('changes nothing when the person says no', async () => {
    shelf.files = [file()];
    const user = show();
    await user.click(screen.getByRole('button', { name: 'storefront.jpg' }));
    await screen.findByRole('dialog', { name: 'Make "storefront.jpg" public?' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual([]);
    expect(chosen).not.toHaveBeenCalled();
  });

  it('says in the server’s words why a file could not be made public, and lets it be tried again', async () => {
    shelf.files = [file()];
    const user = show();
    await user.click(screen.getByRole('button', { name: 'storefront.jpg' }));
    await screen.findByRole('dialog', { name: 'Make "storefront.jpg" public?' });
    const refuse = (status: number, rest: Record<string, unknown> = {}): void => {
      server.answer = () => {
        throw new ApiError({ type: 'about:blank', title: 'Refused', status, ...rest });
      };
    };
    refuse(422, {
      errors: [
        {
          path: '/public',
          code: 'public_media_unavailable',
          message:
            "This install doesn't serve public files yet: it needs PUBLIC_INTAKE_SECRET set.",
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    expect(
      await screen.findByText(
        "This install doesn't serve public files yet: it needs PUBLIC_INTAKE_SECRET set.",
      ),
    ).toBeTruthy();
    refuse(403);
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    expect(
      await screen.findByText('You need permission to manage Media Storage to make a file public.'),
    ).toBeTruthy();
    refuse(409, { detail: 'Someone else changed it first.' });
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    expect(await screen.findByText('Someone else changed it first.')).toBeTruthy();
    refuse(500);
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    expect(
      await screen.findByText(
        "The file couldn't be made public. Check your connection and try again.",
      ),
    ).toBeTruthy();
    server.answer = () => {
      throw new TypeError('Failed to fetch');
    };
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    await waitFor(() => {
      expect(server.calls).toHaveLength(5);
    });
    expect(chosen).not.toHaveBeenCalled();
    // Then it arrives.
    server.answer = () => file({ public: true, publicUrl: address });
    await user.click(screen.getByRole('button', { name: 'Make public and use it' }));
    await waitFor(() => {
      expect(chosen).toHaveBeenCalledTimes(1);
    });
  });

  it('says so where the install has no secure address for a page to use, and offers another file', async () => {
    shelf.files = [
      file({ public: true, publicUrl: 'http://localhost:3000/m/k4v9x2m7/storefront.jpg' }),
    ];
    const user = show();
    await user.click(screen.getByRole('button', { name: 'storefront.jpg' }));
    const told = await screen.findByRole('dialog', {
      name: "This file can't be used on a page here",
    });
    expect(told.textContent).toContain('A page takes pictures from secure addresses only');
    expect(chosen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Choose another' }));
    expect(await screen.findByRole('dialog', { name: 'The library' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'storefront.jpg' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(closed).toHaveBeenCalled();
  });

  it('closes from the library with nothing chosen', async () => {
    shelf.files = [];
    const user = show();
    await user.click(screen.getByRole('button', { name: 'Close the library' }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(chosen).not.toHaveBeenCalled();
  });
});
