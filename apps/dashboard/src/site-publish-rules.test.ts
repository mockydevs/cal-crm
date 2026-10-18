import { describe, expect, it } from 'vitest';
import {
  nodeIdOfPath,
  PREVIEW_MARGIN_MS,
  PREVIEW_WIDTHS,
  previewLifeMs,
  publicPagesOff,
  publishStateOf,
  refusedProblems,
  serverProblems,
  withPageStanding,
} from './site-publish-rules';

describe('publishStateOf', () => {
  it('says where a page stands on the web', () => {
    expect(publishStateOf({ publishedVersion: null, hasUnpublishedChanges: true })).toBe(
      'unpublished',
    );
    expect(publishStateOf({ publishedVersion: 3, hasUnpublishedChanges: false })).toBe('published');
    expect(publishStateOf({ publishedVersion: 3, hasUnpublishedChanges: true })).toBe('changes');
  });

  it('counts changes the editor has not saved yet as changes not yet published', () => {
    expect(publishStateOf({ publishedVersion: 3, hasUnpublishedChanges: false }, true)).toBe(
      'changes',
    );
    expect(publishStateOf({ publishedVersion: null, hasUnpublishedChanges: false }, true)).toBe(
      'unpublished',
    );
  });
});

describe('problems', () => {
  it('reads the element a refusal is about from its path', () => {
    expect(nodeIdOfPath('/document/hero-title')).toBe('hero-title');
    expect(nodeIdOfPath('/document/n3f2504e04f8941d39a0c0305e82c3301')).toBe(
      'n3f2504e04f8941d39a0c0305e82c3301',
    );
    expect(nodeIdOfPath('/version')).toBeNull();
    expect(nodeIdOfPath('/document')).toBeNull();
    expect(nodeIdOfPath('/document/Bad Id')).toBeNull();
    expect(nodeIdOfPath('/document/a/b')).toBeNull();
  });

  it('lists the server’s findings with what blocks first, each in its own order', () => {
    expect(
      serverProblems([
        { code: 'a', message: 'A warning.', nodeId: 'one', blocking: false },
        { code: 'b', message: 'Blocks.', nodeId: null, blocking: true },
        { code: 'c', message: 'Another warning.', nodeId: null, blocking: false },
        { code: 'd', message: 'Blocks too.', nodeId: 'two', blocking: true },
      ]),
    ).toStrictEqual([
      { message: 'Blocks.', nodeId: null, blocking: true },
      { message: 'Blocks too.', nodeId: 'two', blocking: true },
      { message: 'A warning.', nodeId: 'one', blocking: false },
      { message: 'Another warning.', nodeId: null, blocking: false },
    ]);
    expect(serverProblems(undefined)).toStrictEqual([]);
  });

  it('reads a refused publish as problems at their elements', () => {
    expect(
      refusedProblems([
        { path: '/document/form-1', message: 'Choose a form.' },
        { path: '/version', message: 'The page is empty.' },
      ]),
    ).toStrictEqual([
      { message: 'Choose a form.', nodeId: 'form-1', blocking: true },
      { message: 'The page is empty.', nodeId: null, blocking: true },
    ]);
    expect(refusedProblems(undefined)).toStrictEqual([]);
  });
});

describe('previewLifeMs', () => {
  it('asks for a new link a minute before the old one runs out', () => {
    const now = Date.parse('2026-10-12T10:00:00.000Z');
    expect(previewLifeMs('2026-10-12T11:00:00.000Z', now)).toBe(60 * 60_000 - PREVIEW_MARGIN_MS);
    expect(previewLifeMs('2026-10-12T10:00:30.000Z', now)).toBe(0);
    expect(previewLifeMs('2026-10-12T09:00:00.000Z', now)).toBe(0);
    expect(previewLifeMs('not a time', now)).toBe(0);
  });

  it('previews at one width inside each device’s range', () => {
    expect(PREVIEW_WIDTHS).toStrictEqual({ desktop: 1280, tablet: 768, mobile: 360 });
  });
});

describe('withPageStanding', () => {
  const page = (id: string, role: 'control' | 'variation' = 'control') => ({
    id,
    role,
    weight: 100,
    currentVersion: 1,
    publishedVersion: null as number | null,
    publishedAt: null as string | null,
    hasUnpublishedChanges: true,
  });
  const site = {
    id: 'site_1',
    name: 'Spring offer',
    steps: [
      { id: 'step_1', name: 'Landing', liveUrl: null as string | null, pages: [page('page_1')] },
      {
        id: 'step_2',
        name: 'Thanks',
        liveUrl: null as string | null,
        pages: [page('page_2'), page('page_3', 'variation')],
      },
    ],
  };
  const live = 'https://crm.example/s/k4v9/landing';
  const at = '2026-10-12T09:00:00.000Z';

  it('shows a page as published the moment the answer says so, with the step’s address', () => {
    const next = withPageStanding(site, {
      id: 'page_1',
      role: 'control',
      currentVersion: 3,
      publishedVersion: 3,
      publishedAt: at,
      hasUnpublishedChanges: false,
      liveUrl: live,
    });
    expect(next.steps[0]).toMatchObject({
      liveUrl: live,
      pages: [
        { id: 'page_1', currentVersion: 3, publishedVersion: 3, publishedAt: at, weight: 100 },
      ],
    });
    expect(next.steps[0]?.pages[0]?.hasUnpublishedChanges).toBe(false);
    // Everything else is as it was, and what was given is not changed.
    expect(next.steps[1]).toBe(site.steps[1]);
    expect(next.name).toBe('Spring offer');
    expect(site.steps[0]?.liveUrl).toBeNull();
    expect(site.steps[0]?.pages[0]?.publishedVersion).toBeNull();
  });

  it('takes the address away again when the page is unpublished', () => {
    const published = withPageStanding(site, {
      ...page('page_1'),
      publishedVersion: 1,
      publishedAt: at,
      hasUnpublishedChanges: false,
      liveUrl: live,
    });
    const unpublished = withPageStanding(published, { ...page('page_1'), liveUrl: null });
    expect(unpublished.steps[0]?.liveUrl).toBeNull();
    expect(unpublished.steps[0]?.pages[0]?.publishedVersion).toBeNull();
  });

  it('never lets a variation say where the step is live: visitors are served the control', () => {
    const next = withPageStanding(
      { ...site, steps: site.steps.map((step) => ({ ...step, liveUrl: live })) },
      { ...page('page_3', 'variation'), publishedVersion: 2, currentVersion: 2, liveUrl: null },
    );
    expect(next.steps[1]?.liveUrl).toBe(live);
    expect(next.steps[1]?.pages[1]).toMatchObject({ publishedVersion: 2, currentVersion: 2 });
    expect(next.steps[1]?.pages[0]?.publishedVersion).toBeNull();
  });

  it('keeps the step’s address when an answer says nothing of one, and a site without the page as it is', () => {
    const saved = withPageStanding(
      { ...site, steps: site.steps.map((step) => ({ ...step, liveUrl: live })) },
      { ...page('page_1'), currentVersion: 2 },
    );
    expect(saved.steps[0]?.liveUrl).toBe(live);
    expect(saved.steps[0]?.pages[0]?.currentVersion).toBe(2);
    expect(withPageStanding(site, { ...page('page_9'), currentVersion: 2 })).toBe(site);
  });
});

describe('publicPagesOff', () => {
  it('speaks up only when the server says pages are not served', () => {
    expect(publicPagesOff({ enabled: false, reason: 'No PUBLIC_INTAKE_SECRET is set.' })).toBe(
      true,
    );
    expect(publicPagesOff({ enabled: true, reason: null })).toBe(false);
    // An answer that has not arrived, or a server with no such answer, says nothing.
    expect(publicPagesOff(undefined)).toBe(false);
  });
});
