// The team's side on real Postgres: creating, changing and switching a widget, and
// replacing its key.
import { randomUUID } from 'node:crypto';

import { runCommand, type Invocation, type Services } from '@repo/commands';
import { listWebchatWidgets } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ORIGIN, OTHER_ORIGIN, request, startWebchat, type WebchatWorld } from '../test/webchat.js';
import type { PublicWebchatHandlers } from './webchat-public.js';
import { createWebchatRoutes, createWebchatWidgetCommands } from './webchat-widgets.js';

let world: WebchatWorld;
let database: TestDatabase;
let services: Services;
let handlers: PublicWebchatHandlers;
beforeAll(async () => {
  world = await startWebchat(inject('databaseServer'));
  ({ database, services, handlers } = world);
});
afterAll(async () => {
  await world.close();
});

describe('managing a widget', () => {
  const PUBLIC_URL = 'https://crm.example.test';
  const commands = createWebchatWidgetCommands(PUBLIC_URL);
  const input = {
    name: 'Main site',
    allowedOrigins: ['HTTPS://Example.COM/', 'https://example.com', 'https://bücher.example'],
    enabled: true,
    settings: {
      title: 'Chat with us',
      greeting: '',
      emailRequired: true,
      marketingConsentWording: null,
    },
  };
  async function admin() {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const user = await database.fixtures.user();
    const invocation: Invocation = {
      context: {
        ...business.context,
        actorKind: 'user',
        actorId: user.id,
        userId: user.id,
        correlationId: randomUUID(),
      },
      permissions: 'all',
    };
    return { business, invocation };
  }

  it('stores each website once in its canonical form, with a key and the snippet', async () => {
    const { invocation } = await admin();
    const widget = await runCommand(services, commands.create, input, invocation);
    expect(widget).toMatchObject({
      name: 'Main site',
      enabled: true,
      allowedOrigins: ['https://example.com', 'https://xn--bcher-kva.example'],
    });
    expect(widget.publicKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(widget.embedSnippet).toBe(
      `<script async src="${PUBLIC_URL}/webchat/widget.js" data-widget-key="${widget.publicKey}"></script>`,
    );
    expect((await handlers.admit(widget.publicKey, 'https://xn--bcher-kva.example'))?.origin).toBe(
      'https://xn--bcher-kva.example',
    );
  });

  it('refuses a website with no canonical form, and stores nothing', async () => {
    const { invocation, business } = await admin();
    for (const origin of [
      'http://example.com',
      'https://example.com.',
      'https://example.com:99999',
    ])
      await expect(
        runCommand(services, commands.create, { ...input, allowedOrigins: [origin] }, invocation),
      ).rejects.toMatchObject({ issues: [{ path: '/allowedOrigins/0', code: 'invalid_origin' }] });
    expect(
      await database.withTenant(business.context, (sql) =>
        sql.query('select 1 from messaging.webchat_widgets'),
      ),
    ).toEqual([]);
  });

  it('refuses someone whose role does not allow it', async () => {
    const { invocation } = await admin();
    await expect(
      runCommand(services, commands.create, input, { ...invocation, permissions: new Set() }),
    ).rejects.toMatchObject({ permission: 'webchat.manage' });
  });

  it('turns a widget off and on, and the gate follows at once', async () => {
    const { invocation } = await admin();
    const widget = await runCommand(services, commands.create, input, invocation);
    await runCommand(
      services,
      commands.update,
      { id: widget.id, widget: { ...input, enabled: false } },
      invocation,
    );
    expect(await handlers.admit(widget.publicKey, ORIGIN)).toBeUndefined();
    const back = await runCommand(
      services,
      commands.update,
      { id: widget.id, widget: { ...input, allowedOrigins: [OTHER_ORIGIN] } },
      invocation,
    );
    expect(back.allowedOrigins).toEqual([OTHER_ORIGIN]);
    expect(await handlers.admit(widget.publicKey, ORIGIN)).toBeUndefined();
    expect(await handlers.admit(widget.publicKey, OTHER_ORIGIN)).toBeDefined();
  });

  it('replaces a key: the old key and every open session stop at once', async () => {
    const { invocation } = await admin();
    const widget = await runCommand(services, commands.create, input, invocation);
    const admission = await handlers.admit(widget.publicKey, ORIGIN);
    if (admission === undefined) throw new Error('Not admitted.');
    const session = await handlers.start(
      admission,
      { email: 'maya@example.test', marketingConsent: false },
      request(),
    );
    if (session.outcome !== 'ok') throw new Error(session.outcome);
    const rotated = await runCommand(services, commands.rotateKey, { id: widget.id }, invocation);
    expect(rotated.publicKey).not.toBe(widget.publicKey);
    expect(rotated.id).toBe(widget.id);
    expect(await handlers.admit(widget.publicKey, ORIGIN)).toBeUndefined();
    const again = await handlers.admit(rotated.publicKey, ORIGIN);
    if (again === undefined) throw new Error('The new key was not admitted.');
    expect(await handlers.messages(again, session.session.token, 0)).toEqual({
      outcome: 'session_invalid',
    });
  });

  it("cannot reach another business's widget", async () => {
    const mine = await admin();
    const theirs = await admin();
    const widget = await runCommand(services, commands.create, input, theirs.invocation);
    await expect(
      runCommand(services, commands.rotateKey, { id: widget.id }, mine.invocation),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await handlers.admit(widget.publicKey, ORIGIN)).toBeDefined();
  });
});

describe('the admin routes', () => {
  const PUBLIC_URL = 'https://crm.example.test';
  const routes = createWebchatRoutes(PUBLIC_URL);
  const commands = createWebchatWidgetCommands(PUBLIC_URL);
  const input = {
    name: 'Main site',
    allowedOrigins: [ORIGIN],
    enabled: true,
    settings: {
      title: 'Chat with us',
      greeting: '',
      emailRequired: true,
      marketingConsentWording: null,
    },
  };

  it('are the four of the contract, each with its own endpoint', () => {
    expect(routes.map((route) => route.endpoint.operationId)).toEqual([
      'listWebchatWidgets',
      'createWebchatWidget',
      'updateWebchatWidget',
      'rotateWebchatWidgetKey',
    ]);
  });

  it("list a business's own widgets, oldest first, and need the permission", async () => {
    const mine = await world.fixture();
    const theirs = await world.fixture();
    const user = await database.fixtures.user();
    const invocation = (permissions: Invocation['permissions']): Invocation => ({
      context: {
        ...mine.context,
        actorKind: 'user',
        actorId: user.id,
        userId: user.id,
        correlationId: randomUUID(),
      },
      permissions,
    });
    const second = await runCommand(services, commands.create, input, invocation('all'));
    const list = routes.find((route) => route.endpoint.operationId === 'listWebchatWidgets');
    if (list === undefined) throw new Error('No list route.');
    const answer = await list.run(
      { invocation: invocation('all'), params: {}, query: {}, body: undefined },
      services,
    );
    const { data } = listWebchatWidgets.response.schema.parse(answer);
    expect(data.map((widget) => widget.id)).toEqual([
      toPublicId('webchat_widget', mine.widgetId),
      second.id,
    ]);
    expect(data.map((widget) => widget.publicKey)).not.toContain(theirs.key);
    await expect(
      list.run(
        { invocation: invocation(new Set()), params: {}, query: {}, body: undefined },
        services,
      ),
    ).rejects.toMatchObject({ permission: 'webchat.manage' });
  });
});

describe('replacing a key while the business is held', () => {
  // The lock order of webchat-locks.ts, for the one writer that needs the permission.
  it('takes the business before the widget and its sessions', async () => {
    const f = await world.fixture();
    const token = await world.started(f);
    await world.sent(f, token, 'first');
    const [session] = await f.rows<{ id: string }>('select id from messaging.webchat_sessions');
    if (session === undefined) throw new Error('No session.');
    const user = await database.fixtures.user();
    const invocation: Invocation = {
      context: {
        ...f.context,
        actorKind: 'user',
        actorId: user.id,
        userId: user.id,
        correlationId: randomUUID(),
      },
      permissions: 'all',
    };
    const commands = createWebchatWidgetCommands('https://crm.example.test');
    // As the outbound worker and the Inbox's reply hold it.
    const holder = await world.open(f.context);
    await holder.query('select 1 from tenancy.businesses where id = $1 for update', [
      f.business.id,
    ]);
    const rotating = runCommand(
      services,
      commands.rotateKey,
      { id: toPublicId('webchat_widget', f.widgetId) },
      invocation,
    );
    await world.lockWaits(1);
    // It waits with nothing else in its hands: both rows are still free.
    await holder.query('select 1 from messaging.webchat_widgets where id = $1 for update nowait', [
      f.widgetId,
    ]);
    await holder.query('select 1 from messaging.webchat_sessions where id = $1 for update nowait', [
      session.id,
    ]);
    await holder.release();
    const rotated = await rotating;
    expect(rotated.publicKey).not.toBe(f.key);
    expect(await handlers.admit(f.key, ORIGIN)).toBeUndefined();
    const again = await handlers.admit(rotated.publicKey, ORIGIN);
    if (again === undefined) throw new Error('The new key was not admitted.');
    expect(await handlers.messages(again, token, 0)).toEqual({ outcome: 'session_invalid' });
  });
});
