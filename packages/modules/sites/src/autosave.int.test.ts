// The working draft of a page against real Postgres: the editor's own
// saves rewrite one version in place, versions are kept for moments worth going back to,
// the state before a period of editing is never lost, and what visitors are shown is a
// version nothing can rewrite, which the table itself holds to.
import { randomUUID } from 'node:crypto';

import {
  SITE_LIMITS,
  SITE_PAGE_AUTOSAVE_IDLE_MINUTES,
  sitePage,
  sitePageVersionDetail,
  sitePageVersionList,
  siteStep,
  type PageDocument,
  type SitePage,
} from '@repo/contracts';
import type { Invocation } from '@repo/commands';
import { ConflictError, parsePublicId, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { headline, openHarness, pageWith, type Harness, type Tenant } from '../test/harness.js';

let harness: Harness;
beforeAll(async () => {
  harness = await openHarness(inject('databaseServer'));
});
afterAll(async () => {
  await harness.close();
});

const words = (text: string): PageDocument => pageWith([headline('t', text)]);
const request = () => ({ requestId: randomUUID() });

/** A new step's control page: version 1, as it was created. */
async function newPage(t: Tenant): Promise<{ page: SitePage; key: string }> {
  const site = await t.site();
  const step = siteStep.parse(
    await t.call('createSiteStep', {
      params: { id: site.id },
      body: { name: 'Landing', path: 'landing' },
    }),
  );
  return { page: await t.page(step.pages[0]?.id ?? ''), key: site.publicKey ?? '' };
}

/** The editor saving by itself, from the page as it was last read. */
const autosave = async (
  t: Tenant,
  page: SitePage,
  text: string,
  invocation?: Invocation,
): Promise<SitePage> =>
  sitePage.parse(
    await t.call(
      'saveSitePageDraft',
      {
        params: { id: page.id },
        body: {
          baseVersion: page.currentVersion,
          revision: page.revision,
          autosave: true,
          document: words(text),
        },
      },
      invocation,
    ),
  );
/** A save on purpose: "Save a version". */
const keep = async (t: Tenant, page: SitePage, text: string, name?: string): Promise<SitePage> =>
  sitePage.parse(
    await t.call('saveSitePageDraft', {
      params: { id: page.id },
      body: {
        baseVersion: page.currentVersion,
        document: words(text),
        ...(name === undefined ? {} : { name }),
      },
    }),
  );
const publish = async (t: Tenant, page: SitePage, version?: number): Promise<SitePage> =>
  sitePage.parse(
    await t.call('publishSitePage', {
      params: { id: page.id },
      body: { revision: page.revision, ...(version === undefined ? {} : { version }) },
    }),
  );
const versions = async (t: Tenant, page: SitePage) =>
  sitePageVersionList.parse(await t.call('listSitePageVersions', { params: { id: page.id } }))
    .items;
const textOf = async (t: Tenant, page: SitePage, version: number): Promise<string> =>
  JSON.stringify(
    sitePageVersionDetail.parse(
      await t.call('getSitePageVersion', { params: { id: page.id, version: String(version) } }),
    ).document,
  );
const rowsOf = (page: SitePage) =>
  harness.database.as('crm_owner', (sql) =>
    sql.query<{ number: number; draft: boolean; name: string | null; text: string }>(
      `select number, draft, name, document::text as text from sites.page_versions
       where page_id = $1 order by number`,
      [parsePublicId('site_page', page.id)],
    ),
  );
const auditCount = async (name: string, businessId: string): Promise<number> =>
  Number(
    (
      await harness.database.as('crm_owner', (sql) =>
        sql.one<{ count: string }>(
          `select count(*)::text as count from audit.commands
           where command = $1 and business_id = $2 and outcome = 'ok'`,
          [name, businessId],
        ),
      )
    ).count,
  );

/** Runs `work` with the clock so far on that the working draft has been left too long. */
async function later<Value>(minutes: number, work: () => Promise<Value>): Promise<Value> {
  const was = harness.clock.now;
  // The draft's own time is the database's, which is the real clock.
  harness.clock.now = Date.now() + minutes * 60_000;
  try {
    return await work();
  } finally {
    harness.clock.now = was;
  }
}

describe('the editor saving by itself', () => {
  it('writes one working draft in place: fifty autosaves add one version, and the page as it was stays', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    expect(page).toMatchObject({ currentVersion: 1, revision: 1, autosavedAt: null });
    const before = await textOf(t, page, 1);

    page = await autosave(t, page, 'Autosave 1');
    // The first one starts the working draft: the page as it was created is kept behind it.
    expect(page).toMatchObject({ currentVersion: 2, revision: 2 });
    expect(page.autosavedAt).toEqual(expect.any(String));
    for (let n = 2; n <= 50; n += 1) page = await autosave(t, page, `Autosave ${String(n)}`);

    // Still version 2, and every save moved the revision on by one.
    expect(page).toMatchObject({ currentVersion: 2, revision: 51 });
    expect(JSON.stringify(page.document)).toContain('Autosave 50');
    const list = await versions(t, page);
    expect(list.map((each) => [each.number, each.kind, each.current])).toEqual([
      [2, 'draft', true],
      [1, 'saved', false],
    ]);
    // What was there before the editing began is exactly what it was.
    expect(await textOf(t, page, 1)).toBe(before);
    expect(await rowsOf(page)).toHaveLength(2);
    // The draft says when it was last written, and later than when it was begun.
    const draft = list[0];
    expect(Date.parse(draft?.updatedAt ?? '')).toBeGreaterThan(Date.parse(draft?.createdAt ?? ''));
    expect(page.autosavedAt).toBe(draft?.updatedAt);
  });

  it('still refuses a save made from an older state, by version and by revision', async () => {
    const t = await harness.tenant();
    const { page: opened } = await newPage(t);
    const first = await autosave(t, opened, 'Mine');
    // A second editor that read the page when the first one did: its version is stale.
    await expect(autosave(t, opened, 'Theirs')).rejects.toBeInstanceOf(ConflictError);
    const second = await autosave(t, first, 'Mine again');
    // The version number did not move, so only the revision can say this one is stale.
    expect(second.currentVersion).toBe(first.currentVersion);
    await expect(autosave(t, first, 'Stale')).rejects.toBeInstanceOf(ConflictError);
    // A save on purpose from a stale revision is refused too, when it says its revision.
    await expect(
      t.call('saveSitePageDraft', {
        params: { id: first.id },
        body: {
          baseVersion: second.currentVersion,
          revision: first.revision,
          document: words('Stale'),
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(JSON.stringify((await t.page(first.id)).document)).toContain('Mine again');
    expect((await t.page(first.id)).revision).toBe(second.revision);
    // An autosave says its revision, and never a name: refused before anything is read.
    for (const body of [
      { baseVersion: 2, autosave: true, document: words('x') },
      {
        baseVersion: 2,
        autosave: true,
        revision: second.revision,
        name: 'x',
        document: words('x'),
      },
    ])
      await expect(
        t.call('saveSitePageDraft', { params: { id: first.id }, body }),
      ).rejects.toBeInstanceOf(ValidationError);
  });

  it('starts a new draft after a pause, so what an earlier sitting left is a version', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await autosave(t, page, 'Monday 1');
    page = await autosave(t, page, 'Monday 2');
    // One minute short of the pause: still the same sitting.
    page = await later(SITE_PAGE_AUTOSAVE_IDLE_MINUTES - 1, () => autosave(t, page, 'Monday 3'));
    expect(page.currentVersion).toBe(2);
    page = await later(SITE_PAGE_AUTOSAVE_IDLE_MINUTES + 1, () => autosave(t, page, 'Tuesday 1'));
    expect(page.currentVersion).toBe(3);
    page = await autosave(t, page, 'Tuesday 2');
    expect(page.currentVersion).toBe(3);
    expect((await versions(t, page)).map((each) => [each.number, each.kind, each.current])).toEqual(
      [
        [3, 'draft', true],
        [2, 'checkpoint', false],
        [1, 'saved', false],
      ],
    );
    // The checkpoint is what Monday left, and nothing writes into it again.
    expect(await textOf(t, page, 2)).toContain('Monday 3');
    expect(await textOf(t, page, 3)).toContain('Tuesday 2');
  });

  it('starts a new draft when someone else saved last, and names who made each', async () => {
    const t = await harness.tenant();
    const other = await harness.database.fixtures.user({ name: 'Sam Reed' });
    const asOther: Invocation = {
      ...t.as(),
      context: { ...t.as().context, actorId: other.id, userId: other.id },
    };
    let { page } = await newPage(t);
    page = await autosave(t, page, 'Dana 1');
    page = await autosave(t, page, 'Sam 1', asOther);
    expect(page.currentVersion).toBe(3);
    page = await autosave(t, page, 'Sam 2', asOther);
    expect(page.currentVersion).toBe(3);
    page = await autosave(t, page, 'Dana 2');
    expect(page.currentVersion).toBe(4);
    expect(await textOf(t, page, 2)).toContain('Dana 1');
    expect(await textOf(t, page, 3)).toContain('Sam 2');
  });

  it('is not told to anything that listens, but is in the audit log, without the page', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    const events = () =>
      harness.database.as('crm_owner', (sql) =>
        sql.query<{ type: string; payload: unknown }>(
          `select type, payload from events.events
           where business_id = $1 and type = 'site_page.saved' order by occurred_at, id`,
          [t.businessId],
        ),
      );
    for (let n = 1; n <= 5; n += 1) page = await autosave(t, page, `Autosave ${String(n)}`);
    // One event, for the version the first autosave added; none for the four rewrites.
    expect((await events()).map((each) => each.payload)).toEqual([{ version: 2, draft: true }]);
    expect(await auditCount('site_page.save', t.businessId)).toBe(5);
    await keep(t, page, 'Kept', 'Launch copy');
    expect((await events()).map((each) => each.payload)).toEqual([
      { version: 2, draft: true },
      { version: 2 },
    ]);
    const audited = await harness.database.as('crm_owner', (sql) =>
      sql.query<{ input: Record<string, unknown> }>(
        `select input from audit.commands
         where command = 'site_page.save' and business_id = $1 order by recorded_at, id`,
        [t.businessId],
      ),
    );
    expect(audited[0]?.input).toMatchObject({ autosave: true, mode: 'visual' });
    expect(audited[0]?.input).not.toHaveProperty('document');
    expect(audited.at(-1)?.input).toMatchObject({ name: 'Launch copy' });
    expect(audited.at(-1)?.input).not.toHaveProperty('autosave');
  });
});

describe('a version kept on purpose', () => {
  it('keeps the working draft under its number and a name, and the next autosave starts another', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await autosave(t, page, 'Draft');
    page = await keep(t, page, 'Ready', ' Before the launch ');
    // The draft became the kept version: no near-copy of it is left beside it.
    expect(page).toMatchObject({ currentVersion: 2, autosavedAt: null });
    expect((await versions(t, page))[0]).toMatchObject({
      number: 2,
      kind: 'saved',
      name: 'Before the launch',
      current: true,
    });
    expect(await textOf(t, page, 2)).toContain('Ready');
    page = await autosave(t, page, 'After');
    expect(page.currentVersion).toBe(3);
    expect(await textOf(t, page, 2)).toContain('Ready');
    // A save on purpose with no draft to keep adds a version, as it always did.
    const kept = await keep(t, await keep(t, page, 'Three'), 'Four');
    expect(kept.currentVersion).toBe(4);
    expect((await versions(t, kept)).map((each) => [each.number, each.kind, each.name])).toEqual([
      [4, 'saved', null],
      [3, 'saved', null],
      [2, 'saved', 'Before the launch'],
      [1, 'saved', null],
    ]);
  });

  it('adds a version beside a draft that was left too long, or that someone else wrote', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await autosave(t, page, 'Left on Monday');
    page = await later(SITE_PAGE_AUTOSAVE_IDLE_MINUTES, () => keep(t, page, 'Kept on Tuesday'));
    expect(page.currentVersion).toBe(3);
    expect((await versions(t, page)).map((each) => each.kind)).toEqual([
      'saved',
      'checkpoint',
      'saved',
    ]);
    expect(await textOf(t, page, 2)).toContain('Left on Monday');
  });

  it('is what a restore leaves, with the draft it came after kept as it was', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await keep(t, page, 'First');
    page = await autosave(t, page, 'Drafting');
    page = sitePage.parse(
      await t.call('restoreSitePageVersion', {
        params: { id: page.id },
        body: { revision: page.revision, version: 2 },
      }),
    );
    expect(page).toMatchObject({ currentVersion: 4, autosavedAt: null });
    expect((await versions(t, page)).map((each) => [each.number, each.kind])).toEqual([
      [4, 'saved'],
      [3, 'checkpoint'],
      [2, 'saved'],
      [1, 'saved'],
    ]);
    expect((await versions(t, page))[0]?.restoredFrom).toBe(2);
    expect(await textOf(t, page, 3)).toContain('Drafting');
    // The next autosave starts a draft of its own: the restored version is never written into.
    page = await autosave(t, page, 'On from the restore');
    expect(page.currentVersion).toBe(5);
    expect(await textOf(t, page, 4)).toContain('First');
  });

  it('keeps the newest thirty of all kinds, and the live one however old', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await publish(t, await keep(t, page, 'Live'));
    // Fifty autosaves in one sitting are one version: nothing is pushed out by them.
    for (let n = 0; n < 50; n += 1) page = await autosave(t, page, `Sitting ${String(n)}`);
    expect((await versions(t, page)).map((each) => each.number)).toEqual([3, 2, 1]);
    for (let n = 0; n < SITE_LIMITS.versions; n += 1)
      page = await keep(t, page, `Kept ${String(n)}`, `Version ${String(n)}`);
    // The first save on purpose kept the draft under its own number; the rest each added one.
    expect(page.currentVersion).toBe(SITE_LIMITS.versions + 2);
    const numbers = (await versions(t, page)).map((each) => each.number);
    expect(numbers).toHaveLength(SITE_LIMITS.versions + 1);
    expect(numbers[0]).toBe(page.currentVersion);
    expect(numbers.at(-2)).toBe(page.currentVersion - SITE_LIMITS.versions + 1);
    // Version 1 has gone; version 2, which is live, has not.
    expect(numbers.at(-1)).toBe(2);
    expect(await textOf(t, page, 2)).toContain('Live');
  });
});

describe('what visitors are shown', () => {
  it('is a kept version: publishing a working draft keeps it, and the next autosave leaves it alone', async () => {
    const t = await harness.tenant();
    const made = await newPage(t);
    let page = await autosave(t, made.page, 'Offer A');
    page = await publish(t, page);
    expect(page).toMatchObject({ currentVersion: 2, publishedVersion: 2, autosavedAt: null });
    expect((await versions(t, page))[0]).toMatchObject({ kind: 'saved', published: true });
    const live = async () => (await harness.visit.page(made.key, 'landing', request()))?.html ?? '';
    expect(await live()).toContain('Offer A');

    // The same person goes straight on editing: a new draft, never the live version.
    for (let n = 0; n < 5; n += 1) page = await autosave(t, page, `Offer B ${String(n)}`);
    expect(page).toMatchObject({
      currentVersion: 3,
      publishedVersion: 2,
      hasUnpublishedChanges: true,
    });
    expect(await textOf(t, page, 2)).toContain('Offer A');
    expect(await live()).toContain('Offer A');
    expect(await live()).not.toContain('Offer B');
    // Publishing again makes the draft the live version, whole.
    page = await publish(t, page);
    expect(await live()).toContain('Offer B 4');
    expect(page.hasUnpublishedChanges).toBe(false);
  });

  it('is kept even when an older version that is still a draft is the one published', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await autosave(t, page, 'Checkpoint');
    page = await later(SITE_PAGE_AUTOSAVE_IDLE_MINUTES + 5, () => autosave(t, page, 'Newer'));
    expect((await versions(t, page)).map((each) => each.kind)).toEqual([
      'draft',
      'checkpoint',
      'saved',
    ]);
    page = await publish(t, page, 2);
    expect((await rowsOf(page)).map((row) => [row.number, row.draft])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    // The working draft goes on being the working draft.
    page = await autosave(t, page, 'Newer still');
    expect(page).toMatchObject({ currentVersion: 3, publishedVersion: 2 });
  });

  it('cannot be rewritten, whoever tries: the table refuses, not only the application', async () => {
    const t = await harness.tenant();
    let { page } = await newPage(t);
    page = await publish(t, await autosave(t, page, 'Live words'));
    const id = parsePublicId('site_page', page.id) ?? '';
    const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
      const error = await work.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toMatchObject({ constraint });
    };
    // A kept version: its content, its name, and being kept.
    for (const change of [
      `document = jsonb_set(document, '{mode}', '"visual"')`,
      `name = 'Renamed'`,
      `draft = true`,
    ])
      await refused(
        harness.database.as('crm_owner', (sql) =>
          sql.query(`update sites.page_versions set ${change} where page_id = $1 and number = 2`, [
            id,
          ]),
        ),
        'page_versions_kept_immutable',
      );
    // A draft cannot go live without being kept first.
    page = await autosave(t, page, 'A draft');
    await refused(
      harness.database.as('crm_owner', (sql) =>
        sql.query(`update sites.pages set published_version = 3 where id = $1`, [id]),
      ),
      'pages_published_version_kept',
    );
    // And of a draft only the content changes: never which page or which number it is.
    await refused(
      harness.database.as('crm_owner', (sql) =>
        sql.query(
          `update sites.page_versions set created_at = now() where page_id = $1 and number = 3`,
          [id],
        ),
      ),
      'page_versions_identity_immutable',
    );
    expect((await rowsOf(page)).find((row) => row.number === 2)?.text).toContain('Live words');
  });
});
