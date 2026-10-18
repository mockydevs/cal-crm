import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  fieldDefinition,
  me,
  MIN_COLUMN_WIDTH,
  pipelineConfiguration,
  savedView,
  viewList,
} from '@repo/contracts';
import { address, asClient } from '../servers.js';
import { query, signInByLink } from '../signing-in.js';
import { choose } from '../select.js';
import {
  addView,
  createButton,
  expectView,
  openFilters,
  openManageFields,
  openSort,
  openView,
  saveSharing,
  viewAction,
  viewActions,
  viewName,
  viewPanel,
  viewRow,
  viewTab,
  editView,
} from '../lists.js';

test.use(asClient('203.0.113.130'));

test('private contact and deal views become identical shared lists for another signed-in member', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const slug = `views-${suffix}`;
  const ownerEmail = `views-owner-${suffix}@example.test`;
  const memberEmail = `views-member-${suffix}@example.test`;
  await query(
    `with agency as (
    insert into tenancy.agencies(name,slug) values($1,$2) returning id
  ), business as (
    insert into tenancy.businesses(agency_id,name,slug,address)
    select id,'Saved views business',$2,'{"country":"KE"}' from agency returning id,agency_id
  ), types as (
    insert into crm.object_types(business_id,kind,key,singular_label,plural_label)
    select business.id,kind,kind,initcap(kind),initcap(kind)||'s'
    from business,unnest(array['contact','company','deal']) as kind
  ), roles as (
    insert into tenancy.roles(agency_id,scope,key,name,is_builtin)
    select agency.id,'business',role.key,role.name,true from agency,
    (values ('owner','Owner'),('member','Member')) as role(key,name) returning id,key
  ), people as (
    insert into auth.users(email,name) values($3,'Views owner'),($4,'Views member') returning id,email
  ), pipeline as (
    insert into crm.pipelines(business_id,name,position)
    select id,'Bookings',0 from business returning id,business_id
  ), stages as (
    insert into crm.pipeline_stages(business_id,pipeline_id,name,position)
    select business_id,id,'Enquiry',0 from pipeline
  ) insert into tenancy.memberships(user_id,agency_id,business_id,role_id)
    select people.id,business.agency_id,business.id,roles.id from people,business,roles
    where roles.key=case when people.email=$3 then 'owner' else 'member' end`,
    [`Views agency ${suffix}`, slug, ownerEmail, memberEmail],
  );
  const api = `${address('app')}/api/v1`;
  const listAddress = (object: 'contact' | 'deal') =>
    `${address('app')}/b/${slug}/${object === 'contact' ? 'contacts' : 'deals'}`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, ownerEmail, 1);
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === slug);
  if (business === undefined) throw new Error('Saved views fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  for (const firstName of [`Maya ${suffix}`, `Other ${suffix}`]) {
    const response = await page.request.post(`${api}/contacts`, { headers, data: { firstName } });
    expect(response.status()).toBe(201);
  }
  const configuration = pipelineConfiguration.parse(
    await (await page.request.get(`${api}/pipelines`, { headers })).json(),
  );
  const pipeline = configuration.items[0];
  const stage = pipeline?.stages[0];
  if (pipeline === undefined || stage === undefined)
    throw new Error('Saved views fixture has no stage.');
  for (const name of [`Wedding ${suffix}`, `Other ${suffix}`]) {
    const response = await page.request.post(`${api}/deals`, {
      headers,
      data: {
        name,
        pipelineId: pipeline.id,
        stageId: stage.id,
        currency: 'KES',
        amount: '12345.6789',
      },
    });
    expect(response.status()).toBe(201);
  }
  const memberContext = await browser.newContext(asClient('203.0.113.131'));
  try {
    const member = await memberContext.newPage();
    await member.goto(`${address('app')}/sign-in`);
    await signInByLink(member, memberEmail, 1);
    for (const object of ['contact', 'deal'] as const) {
      const query = object === 'contact' ? `Maya ${suffix}` : `Wedding ${suffix}`;
      const title = `${object} list ${suffix}`;
      // The name is always the first column; the other is the one left showing.
      const expectedHeaders =
        object === 'contact'
          ? ['Contact name', 'Phone']
          : // The contact, the owner and the tags are always shown after the columns chosen.
            ['Opportunity name', 'Value', 'Contact', 'Opportunity owner', 'Tags'];
      const searchLabel = object === 'contact' ? 'Search contacts' : 'Search opportunities';
      await page.goto(listAddress(object));
      if (object === 'contact') {
        const sort = await openSort(page);
        await choose(sort.getByRole('combobox', { name: 'Sort by', exact: true }), 'name');
        await page.keyboard.press('Escape');
        const filters = await openFilters(page);
        await choose(filters.getByRole('combobox', { name: 'Created', exact: true }), 'week');
        await filters.getByRole('button', { name: 'Apply', exact: true }).click();
      } else {
        await choose(page.getByRole('combobox', { name: 'Pipeline', exact: true }), pipeline.id);
        await choose(page.getByRole('combobox', { name: 'Status filter', exact: true }), 'all');
        await page.getByRole('button', { name: 'List', exact: true }).click();
      }
      await page.getByRole('searchbox', { name: searchLabel, exact: true }).fill(query);
      const fields = await openManageFields(page);
      for (const column of object === 'contact'
        ? ['Email', 'Business name', 'Created', 'Last activity', 'Tags']
        : ['Stage', 'Status', 'Expected close']) {
        await fields.getByRole('checkbox', { name: column, exact: true }).uncheck();
      }
      await fields.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(page.getByRole('columnheader')).toHaveText(expectedHeaders);
      await addView(page).click();
      await viewName(page).fill(title);
      const response = page.waitForResponse(
        (reply) => reply.url() === `${api}/views` && reply.request().method() === 'POST',
      );
      await createButton(page).click();
      const created = await response;
      expect(created.status()).toBe(201);
      const saved = savedView.parse(await created.json());
      await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();
      expect(saved.visibility).toBe('private');
      // The server keeps the table's own columns with a contact view.
      if (saved.objectKey === 'contact') expect(saved.tableColumns).toEqual(['name', 'phone']);
      await expectView(page, title);
      const privateList = viewList.parse(
        await (await member.request.get(`${api}/views?object=${object}`, { headers })).json(),
      );
      expect(privateList.items.some((item) => item.id === saved.id)).toBe(false);
      await member.goto(listAddress(object));
      await expect(viewTab(member, 'All')).toBeEnabled();
      await expect(viewTab(member, title)).toHaveCount(0);
      await viewAction(page, 'Share with team');
      await saveSharing(page);
      await expect(
        page.getByRole('status').filter({ hasText: 'View shared with everyone.' }),
      ).toBeVisible();
      await viewAction(member, 'Refresh saved views');
      await expect(viewTab(member, title)).toHaveCount(1);
      await openView(member, title);
      await member.reload();
      await expectView(member, title);
      await expect(member.getByRole('searchbox', { name: searchLabel, exact: true })).toHaveValue(
        query,
      );
      await expect(member.getByRole('columnheader')).toHaveText(expectedHeaders);
      await expect(member.getByRole('table')).toContainText(query);
      await expect(member.getByRole('table')).not.toContainText(`Other ${suffix}`);
      // Someone the view is shared with is offered no change to it.
      await viewActions(member).click();
      await expect(member.getByRole('menuitem')).toHaveText(['Refresh saved views']);
      await member.keyboard.press('Escape');
      const sharedList = viewList.parse(
        await (await member.request.get(`${api}/views?object=${object}`, { headers })).json(),
      );
      const shared = sharedList.items.find((item) => item.id === saved.id);
      expect(shared?.state).toEqual(saved.state);
      expect(shared?.columns).toEqual(saved.columns);
      expect(shared?.owner).toEqual({
        membershipId: saved.owner.membershipId,
        name: 'Views owner',
        you: false,
      });
      await viewAction(page, 'Make private');
      await saveSharing(page);
      await expect(page.getByRole('status').filter({ hasText: 'View is private.' })).toBeVisible();
      await viewAction(member, 'Refresh saved views');
      await expect(viewTab(member, title)).toHaveCount(0);
      await expect(
        member.getByText('This saved view is no longer available. Your current filters are kept.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(member.getByRole('table')).toContainText(query);
    }
  } finally {
    await memberContext.close();
  }
});

test('a smart list shows a custom field and a resized column, and is shared by name to view, then to edit', async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const slug = `shared-lists-${suffix}`;
  const emails = {
    owner: `lists-owner-${suffix}@example.test`,
    viewer: `lists-viewer-${suffix}@example.test`,
    other: `lists-other-${suffix}@example.test`,
  };
  await query(
    `with agency as (
    insert into tenancy.agencies(name,slug) values($1,$2) returning id
  ), business as (
    insert into tenancy.businesses(agency_id,name,slug,address)
    select id,'Shared lists business',$2,'{"country":"US"}' from agency returning id,agency_id
  ), types as (
    insert into crm.object_types(business_id,kind,key,singular_label,plural_label)
    select business.id,kind,kind,initcap(kind),initcap(kind)||'s'
    from business,unnest(array['contact','company','deal']) as kind
  ), roles as (
    insert into tenancy.roles(agency_id,scope,key,name,is_builtin)
    select agency.id,'business',role.key,role.name,true from agency,
    (values ('owner','Owner'),('member','Member')) as role(key,name) returning id,key
  ), people as (
    insert into auth.users(email,name)
    values($3,'Lists owner'),($4,'Lists viewer'),($5,'Lists other') returning id,email
  ) insert into tenancy.memberships(user_id,agency_id,business_id,role_id)
    select people.id,business.agency_id,business.id,roles.id from people,business,roles
    where roles.key=case when people.email=$3 then 'owner' else 'member' end`,
    [`Shared lists agency ${suffix}`, slug, emails.owner, emails.viewer, emails.other],
  );
  const api = `${address('app')}/api/v1`;
  const contacts = `${address('app')}/b/${slug}/contacts`;
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, emails.owner, 1);
  const profile = me.parse(await (await page.request.get(`${api}/me`)).json());
  const business = profile.businesses.find((item) => item.slug === slug);
  if (business === undefined) throw new Error('Shared lists fixture has no business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  const created = await page.request.post(`${api}/fields`, {
    headers,
    data: {
      objectKey: 'contact',
      key: 'venue_notes',
      label: 'Venue notes',
      description: 'What the couple said about the venue.',
      valueType: 'text',
      options: [],
      currency: null,
      aiFillSources: [],
      aiOverwrite: 'ask',
      archived: false,
    },
  });
  expect(created.status()).toBe(201);
  const field = fieldDefinition.parse(await created.json());
  const contact = await page.request.post(`${api}/contacts`, {
    headers,
    data: { firstName: `Maya ${suffix}`, fields: { venue_notes: 'Barn by the lake' } },
  });
  expect(contact.status()).toBe(201);

  // The owner adds the field as a column and narrows it from the keyboard.
  await page.goto(contacts);
  const fields = await openManageFields(page);
  await fields.getByRole('checkbox', { name: 'Venue notes', exact: true }).check();
  for (const column of ['Business name', 'Created', 'Last activity', 'Tags'])
    await fields.getByRole('checkbox', { name: column, exact: true }).uncheck();
  await fields.getByRole('button', { name: 'Apply', exact: true }).click();
  const expectedHeaders = ['Contact name', 'Phone', 'Email', 'Venue notes'];
  await expect(page.getByRole('columnheader')).toHaveText(expectedHeaders);
  await expect(page.getByRole('cell', { name: 'Barn by the lake', exact: true })).toBeVisible();
  const edge = page.getByRole('slider', { name: 'Width of the Venue notes column', exact: true });
  await edge.focus();
  await page.keyboard.press('Home');
  await expect(edge).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTH));
  await addView(page).click();
  await viewName(page).fill(`Venues ${suffix}`);
  const saving = page.waitForResponse(
    (reply) => reply.url() === `${api}/views` && reply.request().method() === 'POST',
  );
  await createButton(page).click();
  const saved = savedView.parse(await (await saving).json());
  expect(saved).toMatchObject({
    columnLayout: ['name', 'phone', 'email', field.id],
    columnWidths: { [field.id]: MIN_COLUMN_WIDTH },
  });

  // Shared by name with one member, to view.
  await editView(page);
  await viewRow(page, /^Sharing & permissions/).click();
  const panel = viewPanel(page);
  await panel.getByRole('radio', { name: 'Selected users', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Lists viewer', exact: true }).check();
  const sharing = page.waitForResponse(
    (reply) => reply.url().endsWith('/sharing') && reply.request().method() === 'PUT',
  );
  await saveSharing(page);
  const shared = savedView.parse(await (await sharing).json());
  expect(shared).toMatchObject({
    visibility: 'selected',
    sharing: { everyone: null, people: [{ name: 'Lists viewer', access: 'view' }] },
  });
  await expect(page.getByText('Shared with 1 person', { exact: true })).toBeVisible();

  const contexts = await Promise.all([
    browser.newContext(asClient('203.0.113.132')),
    browser.newContext(asClient('203.0.113.133')),
  ]);
  try {
    const [viewer, other] = await Promise.all(contexts.map((context) => context.newPage()));
    if (viewer === undefined || other === undefined) throw new Error('Two members must sign in.');
    await viewer.goto(`${address('app')}/sign-in`);
    await signInByLink(viewer, emails.viewer, 1);
    await other.goto(`${address('app')}/sign-in`);
    await signInByLink(other, emails.other, 1);

    // The member it is shared with opens the same list, with its field and its width.
    await viewer.goto(contacts);
    await openView(viewer, `Venues ${suffix}`);
    await expect(viewer.getByRole('columnheader')).toHaveText(expectedHeaders);
    await expect(
      viewer.getByRole('slider', { name: 'Width of the Venue notes column', exact: true }),
    ).toHaveAttribute('aria-valuenow', String(MIN_COLUMN_WIDTH));
    await expect(viewer.getByText('You can view', { exact: true })).toBeVisible();
    await viewActions(viewer).click();
    await expect(viewer.getByRole('menuitem')).toHaveText(['Refresh saved views']);
    await viewer.keyboard.press('Escape');

    // Someone else on the team neither sees it nor reaches it.
    await other.goto(contacts);
    await expect(viewTab(other, 'All')).toBeEnabled();
    await expect(viewTab(other, `Venues ${suffix}`)).toHaveCount(0);
    const otherViews = viewList.parse(
      await (await other.request.get(`${api}/views?object=contact`, { headers })).json(),
    );
    expect(otherViews.items.some((item) => item.id === saved.id)).toBe(false);
    const reached = await other.request.put(`${api}/views/${saved.id}/sharing`, {
      headers,
      data: { everyone: 'view', people: [], revision: shared.revision },
    });
    expect(reached.status()).toBe(404);

    // Given editing, the member renames it, and the owner's list is the same list.
    await editView(page);
    await viewRow(page, /^Sharing & permissions/).click();
    await viewPanel(page)
      .getByRole('combobox', { name: 'What Lists viewer can do', exact: true })
      .selectOption('edit');
    await saveSharing(page);
    await expect(
      page.getByRole('status').filter({ hasText: 'View shared with the people chosen.' }),
    ).toBeVisible();
    await viewAction(viewer, 'Refresh saved views');
    await expect(viewer.getByText('You can edit', { exact: true })).toBeVisible();
    await editView(viewer);
    // A member edits the list; who it is shared with stays with those who may share.
    await expect(viewRow(viewer, /^Sharing & permissions/)).toBeDisabled();
    await viewName(viewer).fill(`Venues renamed ${suffix}`);
    await viewPanel(viewer).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(viewer.getByRole('status').filter({ hasText: 'View updated.' })).toBeVisible();
    await viewAction(page, 'Refresh saved views');
    await expect(viewTab(page, `Venues renamed ${suffix}`)).toHaveCount(1);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
