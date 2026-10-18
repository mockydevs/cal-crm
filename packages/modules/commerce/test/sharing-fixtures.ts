// What the tests of printing, sharing and sending share: the module composed as the server
// composes it, with the real files service on a folder of its own, the real outbound queue
// of the messaging module, and public addresses; a business with a mailbox that sends
// conversations, and a contact who agreed to transactional email.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import type { Permission, SalesDocument } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { readContact, readDeal } from '@repo/module-crm';
import { createFiles, type Files } from '@repo/module-files';
import {
  checkContactEmail,
  findContactEmail,
  holdContactEmail,
  queueContactEmail,
} from '@repo/module-messaging';
import { holdActiveBusiness, readBusinessProfile } from '@repo/module-tenancy';
import { localStorage } from '@repo/storage';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, inject } from 'vitest';

import {
  createCommerceRoutes,
  createPublicDocumentHandlers,
  type CommerceOptions,
  type PublicDocumentHandlers,
  type PublicDocumentRequest,
} from '../src/index.js';
import { NOW } from './commerce-fixtures.js';
import { PNG } from './print-fixtures.js';

export const PUBLIC_URL = 'https://crm.example.test';
export const SECRET = 'commerce-sharing-fixture-key-of-32-bytes-or-more';

export interface SharingFixture {
  readonly agency: { readonly id: string };
  readonly business: Awaited<ReturnType<TestDatabase['fixtures']['business']>>;
  /** Someone who may do everything in the business. */
  readonly manager: Invocation;
  readonly withPermissions: (...permissions: Permission[]) => Invocation;
  /** The contact's row id, and its public id. */
  readonly contact: { readonly id: string };
  readonly contactId: string;
  /** The contact's address. */
  readonly email: string;
  /** The business's mailbox, when the fixture has one: its row id. */
  readonly mailboxId: string | undefined;
}

export interface SharingSuite {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly files: Files;
  /** The module as the server composes it. */
  readonly options: CommerceOptions;
  /** A fresh business with a contact; a mailbox and the contact's consent unless left out. */
  readonly fixture: (settings?: {
    readonly mailbox?: boolean;
    readonly consent?: boolean;
    readonly logo?: boolean;
  }) => Promise<SharingFixture>;
  /** Runs one of the module's routes, composed as given or as the server composes it. */
  readonly api: (
    f: SharingFixture,
    operationId: string,
    input?: { readonly params?: unknown; readonly body?: unknown },
    invocation?: Invocation,
    among?: readonly ApiRoute[],
  ) => Promise<unknown>;
  /** The module's routes composed with other options, to try an install that lacks something. */
  readonly routesWith: (changes: Partial<CommerceOptions>) => readonly ApiRoute[];
  /** The public side of the module, as the server mounts it. */
  readonly visitor: PublicDocumentHandlers;
  /** A visitor's request, as the transport describes one. */
  readonly request: () => PublicDocumentRequest;
  /** A draft of one line of 1,500.00, by kind. */
  readonly draft: (f: SharingFixture, kind: 'quote' | 'invoice') => Promise<SalesDocument>;
  /** The same, issued. */
  readonly issued: (f: SharingFixture, kind: 'quote' | 'invoice') => Promise<SalesDocument>;
  /** Sets the moment the module takes as now. */
  readonly at: (to: string) => void;
  /** Rows read as the owner of the database, past row-level security. */
  readonly rows: <Row extends object>(text: string, values?: readonly unknown[]) => Promise<Row[]>;
}

export function sharingSuite(): SharingSuite {
  let database: TestDatabase;
  let db: Database;
  let services: Services;
  let visitor: PublicDocumentHandlers;
  let moment = new Date(NOW);
  const directory = mkdtempSync(join(tmpdir(), 'crm-commerce-sharing-'));
  const files = createFiles({
    storage: localStorage({ directory: join(directory, 'files') }),
    uploadDirectory: join(directory, 'uploads'),
    maxBytes: 5 * 1024 * 1024,
    linkSecret: 'commerce-sharing-file-link-key-of-32-bytes-or-more',
  });
  const options: CommerceOptions = {
    business: { holdActive: holdActiveBusiness, profile: readBusinessProfile },
    contacts: { read: readContact },
    deals: { read: readDeal },
    now: () => moment,
    files: {
      read: async (trx, fileId) => {
        const found = await files.contentIn(trx, fileId);
        return found === undefined
          ? undefined
          : {
              contentType: found.file.contentType,
              size: found.file.size,
              open: () => found.open(),
            };
      },
      store: async (trx, command, file) =>
        (await files.store(trx, command, { ...file, contentType: 'application/pdf' })).id,
    },
    links: { secret: SECRET, publicUrl: PUBLIC_URL },
    mail: {
      hold: holdContactEmail,
      find: findContactEmail,
      check: checkContactEmail,
      send: queueContactEmail,
    },
  };
  const routes = createCommerceRoutes(options);

  beforeAll(async () => {
    database = await testDatabase(inject('databaseServer'));
    db = connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    });
    services = { db, authorize: allowEveryone };
    visitor = createPublicDocumentHandlers(db, options);
  });
  afterAll(async () => {
    await db.destroy();
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const rows: SharingSuite['rows'] = (text, values = []) =>
    database.as('crm_owner', (sql) => sql.query(text, values));

  const api: SharingSuite['api'] = async (
    f,
    operationId,
    input = {},
    invocation = f.manager,
    among = routes,
  ) => {
    const route = among.find((candidate) => candidate.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId} route.`);
    return route.run(
      {
        invocation: {
          ...invocation,
          context: { ...invocation.context, correlationId: randomUUID() },
        },
        params: input.params ?? {},
        query: {},
        body: input.body,
      },
      services,
    );
  };

  const fixture: SharingSuite['fixture'] = async (settings = {}) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id, { name: 'Harbor Lights Events' });
    const user = await database.fixtures.user();
    const email = `maya.${randomUUID().slice(0, 8)}@example.com`;
    const contact = await database.fixtures.contact(business.context, {
      firstName: 'Maya',
      lastName: 'Thompson',
      email,
    });
    const context = {
      ...business.context,
      actorKind: 'user' as const,
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    };
    const manager: Invocation = { context, permissions: 'all' };
    let mailboxId: string | undefined;
    await database.as('crm_owner', async (sql) => {
      // Quiet hours are a contact's, in their time zone; this contact has none set.
      await sql.query(
        'insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)',
        [business.id],
      );
      if (settings.consent !== false)
        await sql.query(
          `insert into messaging.consents
             (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
           values ($1, $2, 'email', 'transactional', 'granted', 'user', 'system')`,
          [business.id, contact.id],
        );
      if (settings.mailbox === false) return;
      const secret = await sql.one<{ id: string }>(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values ($1, $2, 'mailbox.credentials', 1, decode(repeat('03', 32), 'hex'),
                 decode(repeat('ef', 32), 'hex')) returning id`,
        [agency.id, business.id],
      );
      const account = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name)
         values ($1, 'email', 'Billing') returning id`,
        [business.id],
      );
      await sql.query(
        `insert into messaging.mailboxes
           (business_id, id, email_address, display_name, auth_method, smtp_host, smtp_port,
            smtp_security, smtp_username, secret_id)
         values ($1, $2, 'billing@harborlights.example', 'Harbor Lights', 'password',
                 'smtp.example.test', 465, 'tls', 'billing', $3)`,
        [business.id, account.id, secret.id],
      );
      mailboxId = account.id;
    });
    if (settings.logo === true) {
      const logo = await files.upload(services, manager, {
        body: Readable.from([PNG]),
        contentType: 'image/png',
        filename: 'logo.png',
      });
      await rows('update tenancy.businesses set logo_file_id = $1::uuid where id = $2', [
        parsePublicId('file', logo.id),
        business.id,
      ]);
    }
    return {
      agency,
      business,
      manager,
      withPermissions: (...permissions) => ({ context, permissions: new Set(permissions) }),
      contact,
      contactId: toPublicId('contact', contact.id),
      email,
      mailboxId,
    };
  };

  const draft: SharingSuite['draft'] = async (f, kind) =>
    (await api(f, 'createSalesDocument', {
      body: {
        kind,
        contactId: f.contactId,
        currency: 'KES',
        lines: [{ name: 'Wedding day coordination', quantity: '1', unitPrice: '1500.00' }],
        notes: 'Thank you for choosing us.',
        billTo: 'PO Box 4410\nMombasa',
      },
    })) as SalesDocument;

  const issued: SharingSuite['issued'] = async (f, kind) => {
    const made = await draft(f, kind);
    return (await api(f, 'issueSalesDocument', {
      params: { id: made.id },
      body: { revision: made.revision },
    })) as SalesDocument;
  };

  return {
    get database() {
      return database;
    },
    get db() {
      return db;
    },
    files,
    options,
    fixture,
    api,
    routesWith: (changes) => createCommerceRoutes({ ...options, ...changes }),
    get visitor() {
      return visitor;
    },
    request: () => ({
      requestId: randomUUID(),
      ipAddress: '203.0.113.7',
      userAgent: 'TestBrowser/1.0',
    }),
    draft,
    issued,
    at(to) {
      moment = new Date(to);
    },
    rows,
  };
}

/** The token at the end of a public address. */
export function tokenOf(url: string | undefined): string {
  const token = url?.split('/').at(-1);
  if (token === undefined || token === '') throw new Error('The document has no public address.');
  return token;
}
