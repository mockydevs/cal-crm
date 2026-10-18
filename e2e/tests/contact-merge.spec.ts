// Merge Contacts on the whole product: the built dashboard and server, with the worker, over
// a migrated Postgres. Two people chat from the business's website, so each is a contact with
// a web chat conversation of their own, and each is tagged into the same workflow, where they
// wait. The newer one also has a note, a form submission, an appointment and an invoice. Both
// are ticked in the contact list and merged through the dialog, a field taken from the one
// merged away. Everything is made through the public API and the API the dashboard uses.
//
// Then the contact kept has one conversation with both people's messages, the other's note,
// submission, appointment and invoice, and the value picked; the other's workflow run ended
// as contact_merged, since the contact kept is in that workflow already, and is the kept
// contact's history. The other waits in
// the trash, marked merged and not restorable, and its address opens the contact kept.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  appointmentDetail,
  automation,
  automationDraftSaved,
  automationRunList,
  businessProfile,
  calendarConfiguration,
  contact,
  contactList,
  conversationList,
  conversationThread,
  form,
  formSubmissionList,
  me,
  problem,
  publicForm,
  publicWebchatSession,
  recordNotes,
  salesDocument,
  tag,
  trashList,
  userList,
  webchatWidget,
} from '@repo/contracts';
import { address, asClient, inOurs, ours } from '../servers.js';
import { newPerson, signInByLink } from '../signing-in.js';

test.use(asClient('203.0.113.223'));

test('merges two contacts from the list into the one kept, with everything the other had', async ({
  page,
}) => {
  // Many requests before the merge, and the worker's work to wait for.
  test.setTimeout(180_000);
  const person = await newPerson();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  await page.goto(`${address('app')}/sign-in`);
  await signInByLink(page, person.email, 1);
  const api = `${address('app')}/api/v1`;
  const request: APIRequestContext = page.request;
  const profile = me.parse(await (await request.get(`${api}/me`)).json());
  const business = profile.businesses.find((each) => each.slug === ours.slug);
  if (business === undefined) throw new Error('Expected the merge business.');
  const headers = { 'Business-Id': business.id, Origin: address('app') };
  /** Sends one request the dashboard would, and reads its answer with the contract's schema. */
  const call = async <Schema extends { parse: (value: unknown) => unknown }>(
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    schema: Schema,
    data?: unknown,
    status = method === 'post' && !path.endsWith('/publish') ? 201 : 200,
  ): Promise<ReturnType<Schema['parse']>> => {
    const response = await request.fetch(`${api}${path}`, {
      method: method.toUpperCase(),
      headers,
      ...(data === undefined ? {} : { data }),
    });
    expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
    return schema.parse(await response.json()) as ReturnType<Schema['parse']>;
  };

  // The business's website, where its chat and its form are.
  const website = `https://merge-${suffix}.example`;
  const fromWebsite = { origin: website };

  // Two people chat from the website: each becomes a contact with a conversation.
  const widget = await call('post', '/webchat/widgets', webchatWidget, {
    name: `Merge chat ${suffix}`,
    allowedOrigins: [website],
    enabled: true,
    settings: {
      title: 'Chat with us',
      greeting: 'Hello. How can we help?',
      emailRequired: true,
      marketingConsentWording: null,
    },
  });
  const chat = `${api}/public/webchat/${widget.publicKey}`;
  const chatFrom = async (email: string, text: string): Promise<string> => {
    const started = await request.post(`${chat}/sessions`, {
      headers: fromWebsite,
      data: { name: `Visitor ${suffix}`, email, marketingConsent: false },
    });
    expect(started.status(), await started.text()).toBe(201);
    const { token } = publicWebchatSession.parse(await started.json());
    const sent = await request.post(`${chat}/messages`, {
      headers: { ...fromWebsite, authorization: `Bearer ${token}` },
      data: { clientMessageId: randomUUID(), text },
    });
    expect(sent.status(), await sent.text()).toBe(200);
    const found = await call('get', `/contacts?q=${encodeURIComponent(email)}`, contactList);
    const id = found.items.find((each) => each.email === email)?.id;
    if (id === undefined) throw new Error(`The chat made no contact with ${email}.`);
    return id;
  };
  const janeEmail = `jane-${suffix}@example.test`;
  const janetEmail = `janet-${suffix}@example.test`;
  // The older first: it is the master the dialog offers first when ticked first.
  const keptId = await chatFrom(janeEmail, `Jane asks about dates ${suffix}`);
  const otherId = await chatFrom(janetEmail, `Janet asks about prices ${suffix}`);
  const named = async (id: string, firstName: string) =>
    call('patch', `/contacts/${id}`, contact, { firstName, lastName: `Merge${suffix}` });
  const kept = await named(keptId, 'Jane');
  const other = await named(otherId, 'Janet');
  const conversationsOf = (id: string) =>
    call('get', `/conversations?status=all&contactId=${id}`, conversationList);
  for (const each of [kept, other]) expect((await conversationsOf(each.id)).items).toHaveLength(1);

  // A workflow both are tagged into, where each waits a day.
  const marker = await call('post', '/tags', tag, { name: `Merge flow ${suffix}` });
  const saved = await call('post', '/automations', automationDraftSaved, {
    document: {
      name: `Merge wait ${suffix}`,
      triggers: [{ id: 'tagged', type: 'tag.added', config: { tag: marker.id } }],
      start: 'pause',
      steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
    },
  });
  expect(saved.validation.errors).toEqual([]);
  const flow = await call('post', `/automations/${saved.automation.id}/publish`, automation, {
    baseDraftVersion: saved.automation.draftVersion,
  });
  for (const each of [kept, other])
    expect(
      (
        await request.put(`${api}/records/${each.id}/tags/${marker.id}`, { headers, data: {} })
      ).status(),
    ).toBe(200);
  const runs = async () =>
    (await call('get', `/automations/${flow.id}/runs`, automationRunList)).items.map((run) => ({
      contact: run.record.id,
      status: run.status,
      exitReason: run.exitReason,
    }));
  await expect.poll(runs, { timeout: 60_000 }).toEqual(
    expect.arrayContaining([
      { contact: kept.id, status: 'waiting', exitReason: null },
      { contact: other.id, status: 'waiting', exitReason: null },
    ]),
  );

  // The newer one's note.
  const noted = await request.post(`${api}/records/${other.id}/notes`, {
    headers,
    data: {
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `Venue ${suffix}` }] }],
      },
    },
  });
  expect(noted.status()).toBe(201);

  // Their form submission, sent from the website as the embed sends it.
  const draft = await call('post', '/forms', form, { name: `Merge form ${suffix}` });
  const listed = await call('put', `/forms/${draft.id}`, form, {
    name: draft.name,
    definition: draft.definition,
    allowedOrigins: [website],
    revision: draft.revision,
  });
  const published = await call('post', `/forms/${draft.id}/publish`, form, {
    revision: listed.revision,
  });
  const formUrl = `${api}/public/forms/${published.publicKey}`;
  const shown = await request.get(formUrl, { headers: fromWebsite });
  expect(shown.status(), await shown.text()).toBe(200);
  const { renderToken } = publicForm.parse(await shown.json());
  // A form sent sooner than a person could fill it in is refused.
  await page.waitForTimeout(2500);
  const submitted = await request.post(`${formUrl}/submissions`, {
    headers: fromWebsite,
    data: {
      clientSubmissionId: randomUUID(),
      renderToken,
      values: { email: janetEmail },
      consents: {},
      pageUrl: `${website}/enquire`,
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(201);
  const submissions = () => call('get', `/forms/${draft.id}/submissions`, formSubmissionList);
  expect((await submissions()).items.map((each) => each.contactId)).toEqual([other.id]);

  // Their appointment, booked by the team on a calendar of this person's.
  const users = await call(
    'get',
    `/users?type=account&q=${encodeURIComponent(person.email)}`,
    userList,
  );
  const membershipId = users.items.find((each) => each.email === person.email)?.membershipId;
  if (membershipId === undefined || membershipId === null)
    throw new Error('The person has no membership.');
  const calendar = await call('post', '/calendars', calendarConfiguration, {
    name: `Merge tour ${suffix}`,
    kind: 'personal',
    timezone: 'UTC',
    bookingSlug: `merge-tour-${suffix}`,
    isActive: true,
    consentEnabled: false,
    members: [{ membershipId, weight: 1 }],
    weeklyHours: [],
    dateOverrides: [],
  });
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  startsAt.setUTCHours(10, 0, 0, 0);
  const appointment = await call('post', '/appointments', appointmentDetail, {
    requestId: randomUUID(),
    calendarId: calendar.calendar.id,
    contactId: other.id,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    ignoreAvailability: true,
  });

  // Their invoice, a draft in the business's currency.
  const { currency } = await call('get', '/business-profile', businessProfile);
  const invoice = await call('post', '/sales-documents', salesDocument, {
    kind: 'invoice',
    contactId: other.id,
    currency,
    lines: [],
  });

  await page.goto(inOurs(`/contacts?q=Merge${suffix}`));
  const table = page.getByRole('region', { name: 'Contacts table', exact: true });
  await expect(
    table.getByRole('link', { name: `Janet Merge${suffix}`, exact: true }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: `Select Jane Merge${suffix}`, exact: true }).check();
  await page.getByRole('checkbox', { name: `Select Janet Merge${suffix}`, exact: true }).check();
  const bar = page.getByRole('group', { name: 'Bulk actions' });
  await bar.getByRole('button', { name: 'Merge', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Merge Contacts' });
  await expect(
    dialog.getByRole('radio', { name: new RegExp(`^Jane Merge${suffix}`, 'u') }),
  ).toBeChecked();
  const firstName = dialog
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'First name', exact: true }) });
  await firstName.getByRole('radio', { name: 'Janet', exact: true }).check();
  await expect(dialog.getByText('Notes: 1', { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'I understand this cannot be undone' }).check();
  const merging = page.waitForResponse(
    (response) =>
      response.url() === `${api}/contacts/${kept.id}/merge` &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  expect((await merging).status()).toBe(200);

  await expect(page).toHaveURL(new RegExp(`${inOurs(`/contacts/${kept.id}`)}$`, 'u'));
  await expect(
    page.getByText('1 contact was merged into this one.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(`Janet Merge${suffix} · ${ours.name}`);
  const notes = await call('get', `/records/${kept.id}/notes`, recordNotes);
  expect(notes.items.map((each) => each.text)).toContain(`Venue ${suffix}`);
  const after = await call('get', `/contacts/${kept.id}`, contact);
  expect(after.firstName).toBe('Janet');
  expect(after.emails).toEqual(expect.arrayContaining([janeEmail, janetEmail]));

  // One conversation, with both people's messages.
  const conversations = await conversationsOf(kept.id);
  expect(conversations.items).toHaveLength(1);
  const [conversation] = conversations.items;
  if (conversation === undefined) throw new Error('The contact kept has no conversation.');
  const thread = await call(
    'get',
    `/conversations/${conversation.id}/messages`,
    conversationThread,
  );
  const texts = thread.items.flatMap((each) => (each.kind === 'message' ? [each.text] : []));
  expect(texts).toEqual(
    expect.arrayContaining([
      `Jane asks about dates ${suffix}`,
      `Janet asks about prices ${suffix}`,
    ]),
  );

  // Both were waiting in the same workflow: the other's run ended, the kept one's goes on.
  // Both runs are the kept contact's history now, the ended one included.
  await expect.poll(runs, { timeout: 30_000 }).toEqual(
    expect.arrayContaining([
      { contact: kept.id, status: 'waiting', exitReason: null },
      { contact: kept.id, status: 'exited', exitReason: 'contact_merged' },
    ]),
  );

  // The submission, the appointment and the invoice name the contact kept.
  expect((await submissions()).items.map((each) => each.contactId)).toEqual([kept.id]);
  const booked = await call('get', `/appointments/${appointment.id}`, appointmentDetail);
  expect(booked.contact.id).toBe(kept.id);
  const billed = await call('get', `/sales-documents/${invoice.id}`, salesDocument);
  expect(billed.contactId).toBe(kept.id);

  // The one merged away answers 404 naming the contact kept, and its page opens that one.
  const gone = await request.get(`${api}/contacts/${other.id}`, { headers });
  expect(gone.status()).toBe(404);
  expect(problem.parse(await gone.json()).mergedInto).toBe(kept.id);
  await page.goto(inOurs(`/contacts/${other.id}`));
  await expect(page).toHaveURL(new RegExp(`${inOurs(`/contacts/${kept.id}`)}$`, 'u'));
  await expect(
    page.getByText('The contact you opened was merged into this one.', { exact: true }),
  ).toBeVisible();

  // In the trash, marked merged, with no way back.
  const trash = await call('get', '/trash?kind=contact', trashList);
  expect(trash.items.find((each) => each.id === other.id)?.mergedInto).toBe(kept.id);
  await page.goto(inOurs('/trash'));
  const item = page
    .getByRole('list', { name: 'In the trash' })
    .getByRole('listitem')
    .filter({ hasText: `Janet Merge${suffix}` });
  await expect(item).toContainText('Merged into the contact kept');
  await expect(item.getByRole('button', { name: `Restore Janet Merge${suffix}` })).toHaveCount(0);

  // The business is shared with the other tests: the workflow takes nobody new.
  await call('post', `/automations/${flow.id}/pause`, automation, undefined, 200);
});
