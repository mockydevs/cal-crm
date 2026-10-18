// @vitest-environment jsdom
// Email verification on screen: an email row's badge and what it means, the row's menu
// (Verify, Exclude, Block and Unblock, with the hard-bounce confirmation and the opt-outs
// that are not lifted here), and Settings → Email Services → Email Verification with its
// provider. The API is a small world shaped by the contract's own types
// (e2e/email-verification-fixtures.ts).
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { getContactDetails, type ContactAddress } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  addressOf,
  blockedFor,
  blockIn,
  checked,
  connectIn,
  contactAddressesIn,
  disconnectIn,
  excludeIn,
  isRefusal,
  settingsIn,
  testIn,
  unblockIn,
  unchecked,
  updateSettingsIn,
  verificationWorldOf,
  verifiedContactId,
  verifyIn,
  workingKey,
  type VerificationWorld,
} from '../../e2e/email-verification-fixtures';
import { contactDetailsKey } from '../contact-details-data';
import EmailAddressStatus from './address-status';
import EmailVerificationSettingsSection from './settings';

const server = vi.hoisted(
  (): {
    world: VerificationWorld | undefined;
    asked: string[];
    /** Operations the server fails with a 500, as a broken server would. */
    failing: string[];
  } => ({
    world: undefined,
    asked: [],
    failing: [],
  }),
);

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: { body?: unknown }) =>
      Promise.resolve().then(() => {
        const world = server.world;
        if (world === undefined) throw new Error('no server');
        server.asked.push(endpoint.operationId);
        if (server.failing.includes(endpoint.operationId))
          throw new ApiError({ type: 'about:blank', title: 'Server error', status: 500 });
        const answers: Record<string, () => unknown> = {
          getMyPermissions: () => ({ business: null, permissions: world.permissions }),
          verifyEmailAddress: () => verifyIn(world, input.body),
          excludeEmailAddress: () => excludeIn(world, input.body, true),
          includeEmailAddress: () => excludeIn(world, input.body, false),
          blockEmailAddress: () => blockIn(world, input.body),
          unblockEmailAddress: () => unblockIn(world, input.body),
          getEmailVerificationSettings: () => settingsIn(world),
          updateEmailVerificationSettings: () => updateSettingsIn(world, input.body),
          connectEmailVerificationProvider: () => connectIn(world, input.body),
          disconnectEmailVerificationProvider: () => disconnectIn(world),
          testEmailVerificationProvider: () => testIn(world),
        };
        const answer = answers[endpoint.operationId]?.();
        if (answer === undefined) throw new Error(`unexpected ${endpoint.operationId}`);
        if (isRefusal(answer)) {
          const { refusal: _refusal, ...problem } = answer;
          throw new ApiError({ type: 'about:blank', title: 'Refused', ...problem });
        }
        return answer;
      }),
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.world = undefined;
  server.asked = [];
  server.failing = [];
});
afterEach(cleanup);

/** The contact's email rows, read from the world as the contact page reads its details. */
function Rows({ canManage }: { readonly canManage: boolean }): ReactElement {
  const details = useQuery({
    queryKey: contactDetailsKey('biz_test', verifiedContactId),
    queryFn: () => {
      server.asked.push(getContactDetails.operationId);
      return contactAddressesIn(server.world ?? verificationWorldOf());
    },
  });
  return (
    <ul>
      {(details.data ?? []).map((address: ContactAddress) => (
        <li key={address.id} aria-label={address.display}>
          <EmailAddressStatus
            contactId={verifiedContactId}
            address={address}
            canManage={canManage}
          />
        </li>
      ))}
    </ul>
  );
}

function show(
  part: ReactNode,
  world: VerificationWorld = verificationWorldOf(),
  user: ReturnType<typeof userEvent.setup> = userEvent.setup(),
): {
  world: VerificationWorld;
  user: ReturnType<typeof userEvent.setup>;
  client: QueryClient;
  unmount: () => void;
} {
  server.world = world;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>{part}</I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user, client, unmount };
}

const row = (name: string): HTMLElement => screen.getByRole('listitem', { name });

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  address: string,
): Promise<HTMLElement> {
  await user.click(
    await screen.findByRole('button', { name: `Email verification for ${address}` }),
  );
  return screen.findByRole('menu');
}

it('reads each status in order, Blocked first, then Excluded, then the check', async () => {
  show(
    <Rows canManage={false} />,
    verificationWorldOf({
      addresses: [
        addressOf(1, 'bounced@example.com', checked('valid'), blockedFor('hard_bounce')),
        addressOf(2, 'left-out@example.com', checked('invalid', { excluded: true })),
        addressOf(3, 'gone@example.com', checked('invalid', { reasons: ['mailbox_not_found'] })),
        addressOf(4, 'maybe@example.com', checked('risky', { reasons: ['catch_all'] })),
        addressOf(5, 'later@example.com', checked('unknown')),
        addressOf(6, 'good@example.com', checked('valid')),
        addressOf(7, 'domain@example.com', checked('valid', { depth: 'domain' })),
        addressOf(8, 'new@example.com', unchecked()),
      ],
    }),
  );
  const expected = [
    ['bounced@example.com', 'Blocked'],
    ['left-out@example.com', 'Excluded'],
    ['gone@example.com', 'Invalid'],
    ['maybe@example.com', 'Risky'],
    ['later@example.com', 'Unknown'],
    ['good@example.com', 'Verified'],
    ['domain@example.com', 'Domain checked'],
    ['new@example.com', 'Not verified'],
  ];
  for (const [address = '', label = ''] of expected)
    expect(
      (await screen.findByRole('button', { name: `${label}: what this means for ${address}` }))
        .textContent,
    ).toBe(label);
  // Someone who may not change the contact reads the status and gets no menu.
  expect(screen.queryByRole('button', { name: /^Email verification for/ })).toBeNull();
});

it('says what a status means and why, with role and free provider as hints', async () => {
  const { user } = show(
    <Rows canManage={false} />,
    verificationWorldOf({
      addresses: [
        addressOf(
          1,
          'info@example.com',
          checked('risky', { reasons: ['catch_all', 'role', 'free_provider', 'made_up_code'] }),
        ),
        addressOf(2, 'bounced@example.com', checked('invalid'), blockedFor('hard_bounce')),
      ],
    }),
  );
  await user.click(
    await screen.findByRole('button', { name: 'Risky: what this means for info@example.com' }),
  );
  const risky = await screen.findByRole('dialog', { name: 'Risky' });
  expect(
    within(risky).getByText('Emails are still sent to it, but they may not arrive.'),
  ).toBeTruthy();
  expect(within(risky).getByRole('list', { name: 'Why' }).textContent).toBe(
    "Its domain accepts mail for any address, so this mailbox can't be confirmed.",
  );
  expect(within(risky).getByText('Good to know')).toBeTruthy();
  expect(
    within(risky).getByText('It reaches a role, such as info@ or sales@, more than one person.'),
  ).toBeTruthy();
  expect(within(risky).getByText('It is with a free email provider.')).toBeTruthy();
  // A code the dashboard doesn't know is left out, never shown raw.
  expect(within(risky).queryByText(/made_up_code/)).toBeNull();
  expect(within(risky).getByText(/Checked on Oct 17, 2026\./)).toBeTruthy();
  await user.keyboard('{Escape}');

  await user.click(
    screen.getByRole('button', { name: 'Blocked: what this means for bounced@example.com' }),
  );
  const blocked = await screen.findByRole('dialog', { name: 'Blocked' });
  expect(within(blocked).getByText('No email is sent to this address.')).toBeTruthy();
  expect(
    within(blocked).getByText("An email to it bounced: the mailbox doesn't take mail."),
  ).toBeTruthy();
});

it('says an old result is checked again, and a domain check is only a domain check', async () => {
  const { user } = show(
    <Rows canManage={false} />,
    verificationWorldOf({
      addresses: [
        addressOf(
          1,
          'old@example.com',
          checked('valid', { depth: 'domain', expiresAt: '2026-01-01T00:00:00.000Z' }),
        ),
      ],
    }),
  );
  await user.click(
    await screen.findByRole('button', {
      name: 'Domain checked: what this means for old@example.com',
    }),
  );
  const panel = await screen.findByRole('dialog', { name: 'Domain checked' });
  expect(
    within(panel).getByText(
      'The domain takes mail. Checking the mailbox itself needs a verification provider.',
    ),
  ).toBeTruthy();
  expect(
    within(panel).getByText(
      'Domain checked on Oct 17, 2026. The result is old enough to be checked again before the next email.',
    ),
  ).toBeTruthy();
});

it('verifies an address, says a check is coming, and offers Re-verify once checked', async () => {
  const { world, user } = show(<Rows canManage />);
  const menu = await openMenu(user, 'maya@example.com');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Verify email', 'Exclude from email verification', 'Block email']);
  await user.click(within(menu).getByRole('menuitem', { name: 'Verify email' }));
  expect(
    await within(row('maya@example.com')).findByText(
      "Checking maya@example.com. The result shows here once it's done.",
    ),
  ).toBeTruthy();
  expect(world.writes).toEqual([
    {
      operationId: 'verifyEmailAddress',
      body: { contactId: verifiedContactId, addressId: world.addresses[0]?.id },
    },
  ]);

  const [address] = world.addresses;
  if (address !== undefined) address.verification = checked('valid');
  world.pending = false;
  // The row reads the details again by itself while the check runs.
  await waitFor(
    () => {
      expect(
        screen.getByRole('button', { name: 'Verified: what this means for maya@example.com' }),
      ).toBeTruthy();
    },
    { timeout: 9000 },
  );
  expect(
    within(row('maya@example.com')).getByText('The check of maya@example.com is done.'),
  ).toBeTruthy();
  const again = await openMenu(user, 'maya@example.com');
  await user.click(within(again).getByRole('menuitem', { name: 'Re-verify' }));
  expect(
    await within(row('maya@example.com')).findByText(
      'The latest check of maya@example.com is shown.',
    ),
  ).toBeTruthy();
});

it('excludes an address from verification and includes it again', async () => {
  const { world, user } = show(
    <Rows canManage />,
    verificationWorldOf({ addresses: [addressOf(1, 'maya@example.com', checked('risky'))] }),
  );
  await user.click(
    within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', {
      name: 'Exclude from email verification',
    }),
  );
  expect(
    await screen.findByRole('button', { name: 'Excluded: what this means for maya@example.com' }),
  ).toBeTruthy();
  expect(
    within(row('maya@example.com')).getByText(
      'maya@example.com is excluded from email verification.',
    ),
  ).toBeTruthy();
  // An excluded address is not checked: no Verify, and Include in its place.
  const menu = await openMenu(user, 'maya@example.com');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Include in email verification', 'Block email']);
  await user.click(within(menu).getByRole('menuitem', { name: 'Include in email verification' }));
  expect(
    await screen.findByRole('button', { name: 'Risky: what this means for maya@example.com' }),
  ).toBeTruthy();
  expect(world.writes.map((each) => each.operationId)).toEqual([
    'excludeEmailAddress',
    'includeEmailAddress',
  ]);
});

it("shows the server's words when a change is refused", async () => {
  const world = verificationWorldOf({
    addresses: [addressOf(1, 'maya@example.com', checked('valid'))],
  });
  const { user } = show(<Rows canManage />, world);
  await screen.findByRole('button', { name: 'Verified: what this means for maya@example.com' });
  // Someone else excluded it since the page read it.
  const [address] = world.addresses;
  if (address !== undefined) address.verification = checked('valid', { excluded: true });
  await user.click(
    within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', { name: 'Re-verify' }),
  );
  expect((await within(row('maya@example.com')).findByRole('alert')).textContent).toBe(
    'Include this address in verification first.',
  );
});

it('blocks an address with a reason, and unblocks it at once', async () => {
  const { world, user } = show(<Rows canManage />);
  await user.click(
    within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', { name: 'Block email' }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Block maya@example.com?' });
  expect(
    within(dialog).getByText('No email is sent to this address until someone unblocks it.'),
  ).toBeTruthy();
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Reason (optional)' }),
    ' Asked us to stop ',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Block' }));
  expect(
    await screen.findByRole('button', { name: 'Blocked: what this means for maya@example.com' }),
  ).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(
    within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', { name: 'Unblock' }),
  );
  expect(
    await screen.findByRole('button', {
      name: 'Not verified: what this means for maya@example.com',
    }),
  ).toBeTruthy();
  expect(world.writes.map((each) => each.body)).toEqual([
    { contactId: verifiedContactId, addressId: world.addresses[0]?.id, reason: 'Asked us to stop' },
    { contactId: verifiedContactId, addressId: world.addresses[0]?.id },
  ]);
});

it('unblocks a hard bounce only once "unblock" is typed, for someone who may', async () => {
  const { world, user } = show(
    <Rows canManage />,
    verificationWorldOf({
      addresses: [addressOf(1, 'maya@example.com', checked('invalid'), blockedFor('hard_bounce'))],
    }),
  );
  await screen.findByRole('button', { name: 'Blocked: what this means for maya@example.com' });
  await waitFor(() => {
    expect(server.asked).toContain('getMyPermissions');
  });
  await user.click(
    within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', { name: 'Unblock' }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Unblock maya@example.com?' });
  const confirm = within(dialog).getByRole('button', { name: 'Unblock' });
  expect(confirm).toHaveProperty('disabled', true);
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Type unblock to confirm' }),
    'unblock',
  );
  expect(confirm).toHaveProperty('disabled', false);
  await user.click(confirm);
  expect(
    await screen.findByRole('button', { name: 'Invalid: what this means for maya@example.com' }),
  ).toBeTruthy();
  expect(world.writes.at(-1)?.body).toEqual({
    contactId: verifiedContactId,
    addressId: world.addresses[0]?.id,
    confirm: 'unblock',
  });
});

it('leaves a hard bounce blocked for someone who may not manage verification', async () => {
  const { user } = show(
    <Rows canManage />,
    verificationWorldOf({
      permissions: ['contacts.manage'],
      addresses: [addressOf(1, 'maya@example.com', checked('invalid'), blockedFor('hard_bounce'))],
    }),
  );
  await waitFor(() => {
    expect(server.asked).toContain('getMyPermissions');
  });
  const menu = await openMenu(user, 'maya@example.com');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent),
  ).toEqual(['Re-verify', 'Exclude from email verification']);
});

it('says why an opt-out is not unblocked here', async () => {
  const { world, user } = show(
    <Rows canManage />,
    verificationWorldOf({
      addresses: [
        addressOf(1, 'spam@example.com', checked('valid'), blockedFor('complaint')),
        addressOf(2, 'left@example.com', checked('valid'), blockedFor('unsubscribe')),
      ],
    }),
  );
  await user.click(
    within(await openMenu(user, 'spam@example.com')).getByRole('menuitem', {
      name: "Why it can't be unblocked",
    }),
  );
  const complaint = await screen.findByRole('dialog', {
    name: "spam@example.com can't be unblocked here",
  });
  expect(within(complaint).getByText(/They marked an email from you as spam\./)).toBeTruthy();
  // The dialog's own Close, after the corner's.
  const closes = within(complaint).getAllByRole('button', { name: 'Close' });
  expect(closes).toHaveLength(2);
  await user.click(closes[1] ?? complaint);
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  await user.click(
    within(await openMenu(user, 'left@example.com')).getByRole('menuitem', {
      name: "Why it can't be unblocked",
    }),
  );
  const unsubscribed = await screen.findByRole('dialog', {
    name: "left@example.com can't be unblocked here",
  });
  expect(within(unsubscribed).getByText(/They unsubscribed from your email\./)).toBeTruthy();
  expect(world.writes).toEqual([]);
});

it('shows only what it always showed when the server says nothing about verification', () => {
  server.world = verificationWorldOf();
  const plain: ContactAddress = {
    id: 'cid_01k8e2wzr0e008000000000009',
    kind: 'email',
    value: 'old@example.com',
    display: 'old@example.com',
    label: null,
    primary: true,
    delivery: { status: 'unchecked', reason: null, since: null },
  };
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider i18n={i18n}>
        <EmailAddressStatus contactId={verifiedContactId} address={plain} canManage />
        <EmailAddressStatus
          contactId={verifiedContactId}
          address={{ ...plain, delivery: { status: 'blocked', reason: 'manual', since: null } }}
          canManage
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Blocked']);
  expect(container.textContent).toBe('Blocked');
});

// Settings → Email Services → Email Verification.

it('connects Emailable with a key the provider confirms, and says so', async () => {
  const { world, user } = show(<EmailVerificationSettingsSection />);
  const section = await screen.findByRole('region', { name: 'Email Verification' });
  expect(
    await within(section).findByText(
      'Mailbox checks need a verification provider. Domain checks still run.',
    ),
  ).toBeTruthy();
  await user.click(within(section).getByRole('button', { name: 'Connect Emailable' }));
  const key = within(section).getByLabelText('Emailable API key');
  expect(key).toHaveProperty('type', 'password');
  expect(document.activeElement).toBe(key);
  await user.click(within(section).getByRole('button', { name: 'Connect' }));
  expect(within(section).getByRole('alert').textContent).toBe(
    'Enter the API key from your Emailable account.',
  );
  await user.type(key, 'test_wrong');
  await user.click(within(section).getByRole('button', { name: 'Connect' }));
  expect((await within(section).findByRole('alert')).textContent).toBe(
    'The verification provider could not confirm this key.',
  );
  await user.clear(key);
  await user.type(key, workingKey);
  await user.click(within(section).getByRole('button', { name: 'Connect' }));
  expect(await within(section).findByText('Emailable connected')).toBeTruthy();
  expect(within(section).getByText('4,800 credits left.')).toBeTruthy();
  expect(within(section).getByText('Test mode')).toBeTruthy();
  expect(within(section).getByText('Emailable is connected.')).toBeTruthy();
  expect(within(section).queryByLabelText('Emailable API key')).toBeNull();
  expect(world.writes.map((each) => each.operationId)).toEqual([
    'connectEmailVerificationProvider',
    'connectEmailVerificationProvider',
  ]);
});

it('saves verify before sending, re-verify after 90 days and the daily limit', async () => {
  const { world, user } = show(<EmailVerificationSettingsSection />);
  const form = await screen.findByRole('form', { name: 'Verification settings' });
  const verify = within(form).getByRole('checkbox', {
    name: 'Verify email addresses before sending',
  });
  const reverify = within(form).getByRole('checkbox', {
    name: 'Re-verify results older than 90 days',
  });
  expect(verify).toHaveProperty('checked', true);
  expect(reverify).toHaveProperty('checked', true);
  const limit = within(form).getByRole('textbox', { name: 'Daily verification limit' });
  expect(limit).toHaveProperty('value', '1000');
  await user.click(reverify);
  await user.clear(limit);
  await user.type(limit, '200000');
  await user.click(within(form).getByRole('button', { name: 'Save' }));
  expect(within(form).getByRole('alert').textContent).toBe(
    'Give a whole number from 0 to 100,000.',
  );
  expect(world.writes).toEqual([]);
  await user.clear(limit);
  await user.type(limit, '250');
  await user.click(within(form).getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Email verification saved.')).toBeTruthy();
  expect(world.writes).toEqual([
    {
      operationId: 'updateEmailVerificationSettings',
      body: { enabled: true, reverifyAfter90Days: false, dailyLimit: 250 },
    },
  ]);
  expect(world.settings.dailyLimit).toBe(250);
});

it('tests and disconnects a connected provider, and says when it needs attention', async () => {
  const { world, user } = show(
    <EmailVerificationSettingsSection />,
    verificationWorldOf({
      settings: { provider: 'failing', availableCredits: 12, testMode: false },
    }),
  );
  const section = await screen.findByRole('region', { name: 'Email Verification' });
  expect(await within(section).findByText('Emailable needs attention')).toBeTruthy();
  expect(within(section).getByText(/Emailable stopped accepting the saved key/)).toBeTruthy();
  expect(within(section).queryByText('Test mode')).toBeNull();
  await user.click(within(section).getByRole('button', { name: 'Test connection' }));
  expect(
    await within(section).findByText(
      'Testing the connection. Its credits and status update here in a moment.',
    ),
  ).toBeTruthy();
  await user.click(within(section).getByRole('button', { name: 'Disconnect' }));
  const dialog = await screen.findByRole('dialog', { name: 'Disconnect Emailable?' });
  await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
  expect(
    await within(section).findByText('Emailable is disconnected. Only domains are checked now.'),
  ).toBeTruthy();
  expect(
    within(section).getByText(
      'Mailbox checks need a verification provider. Domain checks still run.',
    ),
  ).toBeTruthy();
  expect(world.writes.map((each) => each.operationId)).toEqual([
    'testEmailVerificationProvider',
    'disconnectEmailVerificationProvider',
  ]);
});

it('shows nothing to someone who may not manage email verification', async () => {
  const { container } = render(<div />);
  show(
    <EmailVerificationSettingsSection />,
    verificationWorldOf({ permissions: ['contacts.manage'] }),
  );
  await waitFor(() => {
    expect(server.asked).toContain('getEmailVerificationSettings');
  });
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Email Verification' })).toBeNull();
  });
  expect(container.textContent).toBe('');
});

it('reads the details again at most six times while a check runs, and stops when the row goes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    // The check never finishes while the row is open.
    show(<Rows canManage />, verificationWorldOf(), user);
    const reads = (): number =>
      server.asked.filter((each) => each === getContactDetails.operationId).length;
    await user.click(
      within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', {
        name: 'Verify email',
      }),
    );
    await within(row('maya@example.com')).findByText(
      "Checking maya@example.com. The result shows here once it's done.",
    );
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
    // Fake timers draw the row a step late, so give the six reads plenty of room.
    for (let tick = 0; tick < 20; tick += 1) await vi.advanceTimersByTimeAsync(4000);
    expect(reads()).toBe(2 + 6);
    for (let tick = 0; tick < 10; tick += 1) await vi.advanceTimersByTimeAsync(4000);
    expect(reads()).toBe(2 + 6);
    cleanup();

    // A row that goes while it waits asks nothing more.
    show(<Rows canManage />, verificationWorldOf(), user);
    await user.click(
      within(await openMenu(user, 'maya@example.com')).getByRole('menuitem', {
        name: 'Verify email',
      }),
    );
    await within(row('maya@example.com')).findByText(
      "Checking maya@example.com. The result shows here once it's done.",
    );
    await vi.advanceTimersByTimeAsync(4000);
    const before = reads();
    cleanup();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(reads()).toBe(before);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the key out of the query client once Emailable is connected', async () => {
  const { client, user } = show(<EmailVerificationSettingsSection />);
  const section = await screen.findByRole('region', { name: 'Email Verification' });
  await user.click(await within(section).findByRole('button', { name: 'Connect Emailable' }));
  await user.type(within(section).getByLabelText('Emailable API key'), 'test_wrong');
  await user.click(within(section).getByRole('button', { name: 'Connect' }));
  await within(section).findByRole('alert');
  await user.clear(within(section).getByLabelText('Emailable API key'));
  await user.type(within(section).getByLabelText('Emailable API key'), workingKey);
  await user.click(within(section).getByRole('button', { name: 'Connect' }));
  expect(await within(section).findByText('Emailable is connected.')).toBeTruthy();
  const kept = JSON.stringify([
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  ]);
  expect(kept).not.toContain(workingKey);
  expect(kept).not.toContain('test_wrong');
});

it('leaves the keyboard where it is when the section is drawn again during Connect', async () => {
  const { client, user, world } = show(<EmailVerificationSettingsSection />);
  const section = await screen.findByRole('region', { name: 'Email Verification' });
  await user.click(await within(section).findByRole('button', { name: 'Connect Emailable' }));
  expect(document.activeElement).toBe(within(section).getByLabelText('Emailable API key'));
  const cancel = within(section).getByRole('button', { name: 'Cancel' });
  cancel.focus();
  // The settings are read again, as on coming back to the window.
  client.setQueryData(['b', 'biz_test', 'email-verification-settings'], {
    ...world.settings,
    dailyLimit: 999,
  });
  await within(section).findByDisplayValue('999');
  expect(document.activeElement).toBe(cancel);
});

it('says the settings could not be loaded when the server fails, rather than hiding them', async () => {
  server.failing = ['getEmailVerificationSettings'];
  show(<EmailVerificationSettingsSection />);
  const section = await screen.findByRole('region', { name: 'Email Verification' });
  const alert = await within(section).findByRole('alert', {}, { timeout: 9000 });
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
});

it('reads the settings again 3 and 10 seconds after a test, and not after the section goes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const { unmount } = show(
      <EmailVerificationSettingsSection />,
      verificationWorldOf({
        settings: { provider: 'connected', availableCredits: 10, testMode: false },
      }),
      user,
    );
    const reads = (): number =>
      server.asked.filter((each) => each === 'getEmailVerificationSettings').length;
    const section = await screen.findByRole('region', { name: 'Email Verification' });
    await user.click(await within(section).findByRole('button', { name: 'Test connection' }));
    await within(section).findByText(
      'Testing the connection. Its credits and status update here in a moment.',
    );
    const before = reads();
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => {
      expect(reads()).toBe(before + 1);
    });
    await vi.advanceTimersByTimeAsync(7000);
    await waitFor(() => {
      expect(reads()).toBe(before + 2);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toBe(before + 2);

    await user.click(within(section).getByRole('button', { name: 'Test connection' }));
    await vi.advanceTimersByTimeAsync(1000);
    const gone = reads();
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toBe(gone);
  } finally {
    vi.useRealTimers();
  }
});
