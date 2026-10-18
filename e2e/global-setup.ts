// Starts what an install runs, once for the test run: Postgres, migrated (@repo/testing),
// Mailpit to catch the mail, then the built server twice. One serves the built dashboard
// and signs people in for real; the other acts for a second business in the same agency,
// through the development stand-in for signing in, to show what it can't see. Checkpoint 1A,
// Checkpoint 1C ("Inbox day"), Checkpoint 1D ("Booking day"), Checkpoint 1E ("Automation
// day"), Settings → AI models ("Model day"), the assistant's reply drafts ("Draft day") and
// email verification ("Verify day") each get an install of their own. Each server's log is in test-results/servers.
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { bootstrapFile, migrateDatabase } from '@repo/db';
import {
  startDatabaseServer,
  startGreenMail,
  startMailpit,
  testDatabase,
  type TestDatabase,
} from '@repo/testing';

import { startFakeClaude } from '../apps/server/test/fake-claude.js';
import { startFakeEmailable } from '../apps/server/test/fake-emailable.js';
import { startFakeTwilio } from '../apps/server/test/fake-twilio.js';
import { startFakeOpenAi } from '../packages/modules/ai/test/fake-openai.js';
import { startFakeProvider } from '../packages/modules/integrations/test/fake-provider.js';
import { startHttpsFront } from './https-front.js';
import {
  automationDay,
  bookingDay,
  bulkVerifyDay,
  draftDay,
  inboxDay,
  integrationsDay,
  modelDay,
  ours,
  owner,
  theirs,
  variables,
  verifyDay,
  type InboxDayMailServer,
} from './servers.js';

const repository = new URL('../', import.meta.url);
const serverDirectory = fileURLToPath(new URL('apps/server/', repository));
const builtDashboard = fileURLToPath(new URL('apps/dashboard/dist/', repository));
const dashboardDirectory = fileURLToPath(new URL('test-results/dashboard/', import.meta.url));
const logDirectory = fileURLToPath(new URL('test-results/servers/', import.meta.url));

type Stop = () => Promise<void>;

/**
 * Copies the built dashboard to where the servers serve it from. A server reads a page's
 * files from disk at each request, and a build empties the folder and writes it again, so
 * a build made while the tests ran gave a page a 404 and its test a blank page. Nothing
 * else writes to the copy. A build that is missing or half written stops the run here,
 * with the reason.
 *
 * The server's own build is not copied: Node has read it by the time a server is ready.
 */
async function copyDashboard(): Promise<void> {
  await rm(dashboardDirectory, { recursive: true, force: true });
  await cp(builtDashboard, dashboardDirectory, { recursive: true });
  const manifestFile = join(dashboardDirectory, '.vite', 'manifest.json');
  const whole =
    existsSync(join(dashboardDirectory, 'index.html')) &&
    existsSync(manifestFile) &&
    Object.values(
      JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>,
    ).every(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        'file' in chunk &&
        typeof chunk.file === 'string' &&
        existsSync(join(dashboardDirectory, chunk.file)),
    );
  if (!whole)
    throw new Error(
      `There is no whole build of the dashboard in ${builtDashboard}. Build it first (pnpm --filter @repo/dashboard build), and not while these tests start.`,
    );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('No free port.'));
        else resolve(address.port);
      });
    });
  });
}

/**
 * Makes the four built-in roles of an agency and one person who owns the business, as the
 * first start sets them up.
 */
async function seedOwner(
  database: TestDatabase,
  agencyId: string,
  businessId: string,
  person: { readonly name: string; readonly email: string },
): Promise<{ id: string }> {
  const user = await database.fixtures.user(person);
  await database.as('crm_owner', async (sql) => {
    await sql.query(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin) values ($1, 'business', 'admin', 'Admin', true), ($1, 'business', 'member', 'Member', true), ($1, 'business', 'viewer', 'Viewer', true)`,
      [agencyId],
    );
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, 'business', 'owner', 'Owner', true) returning id`,
      [agencyId],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4)`,
      [user.id, agencyId, businessId, role.id],
    );
  });
  return user;
}

/**
 * Runs the built server as the image does, and waits until it's ready. `entry` is the
 * file Node runs: the image's own main.js unless a stack needs another (inbox-day-server.ts).
 */
async function startServer(
  name: string,
  env: Record<string, string>,
  entry = 'dist/main.js',
): Promise<{ url: string; port: number; stop: Stop }> {
  const port = await freePort();
  // People reach it as localhost: a passkey belongs to a site's host name, and WebAuthn
  // refuses an IP address for one. It listens on 127.0.0.1, which localhost reaches.
  const url = `http://localhost:${String(port)}`;
  const direct = `http://127.0.0.1:${String(port)}`;
  const log = createWriteStream(`${logDirectory}${name}.log`);
  const child = spawn(
    process.execPath,
    ['--import', './dist/instrumentation.js', entry],
    // Only what's given here, so nothing from the developer's environment leaks in.
    {
      cwd: serverDirectory,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOST: '127.0.0.1',
        PORT: String(port),
        // Each server is its own public address, so pages it serves may post to it.
        PUBLIC_URL: url,
        ...env,
      },
    },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exited = once(child, 'exit');
  const stop: Stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    log.end();
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`The ${name} server stopped while starting: see ${logDirectory}${name}.log`);
    }
    const ready = await fetch(`${direct}/ready`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return { url, port, stop };
    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `The ${name} server wasn't ready in a minute: see ${logDirectory}${name}.log`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export default async function globalSetup(): Promise<Stop> {
  await mkdir(logDirectory, { recursive: true });
  await copyDashboard();
  // Undone in reverse, by the teardown or by a setup that fails partway. Every step runs,
  // even after one fails, so a database that won't drop doesn't leave Postgres running.
  const stops: Stop[] = [];
  const stopAll: Stop = async () => {
    const failures: unknown[] = [];
    for (const stop of stops.splice(0).reverse()) {
      await stop().catch((failure: unknown) => failures.push(failure));
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Stopping the test run failed.');
  };

  try {
    const postgres = await startDatabaseServer({
      bootstrapFile,
      migrate: (connectionString) => migrateDatabase({ connectionString }),
    });
    stops.push(postgres.stop);
    // Catches the mail the app sends, such as sign-in links.
    const mailpit = await startMailpit();
    stops.push(mailpit.stop);
    const database = await testDatabase(postgres.connection);
    stops.push(() => database.close());

    const agency = await database.fixtures.agency({ name: 'Bluebird Digital' });
    const harbor = await database.fixtures.business(agency.id, ours);
    const northwind = await database.fixtures.business(agency.id, theirs);
    // The owner works in our business.
    const dana = await seedOwner(database, agency.id, harbor.id, owner);
    const signIn = {
      SMTP_URL: mailpit.server.smtpUrl,
      MAIL_FROM: 'Bluebird Digital <crm@bluebird.example>',
      DATABASE_AUTH_URL: database.url('crm_auth'),
      AUTH_SECRET: 'an-end-to-end-secret-of-32-characters-or-more',
      FILES_DIR: join(tmpdir(), 'crm-e2e-files'),
      FILES_LINK_SECRET: 'an-end-to-end-files-link-secret-of-32-characters',
    };

    // ROLE all runs the worker too, on its own connection to the queue, and opens secrets
    // with .env.example's key; ROLE app seals them with its public key.
    const app = await startServer('app', {
      ROLE: 'all',
      DATABASE_APP_URL: database.url('crm_app'),
      DATABASE_WORKER_URL: database.url('crm_worker'),
      ...signIn,
      SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
      DASHBOARD_DIR: dashboardDirectory,
      // The browser is its proxy, so each test file can be its own client (servers.ts).
      TRUST_PROXY: 'loopback',
      // Mounts what the public reaches without signing in: booking pages and web chat.
      PUBLIC_INTAKE_SECRET: 'an-end-to-end-public-intake-secret-of-32-bytes-or-more',
    });
    stops.push(app.stop);
    const otherBusiness = await startServer('other-business', {
      ROLE: 'app',
      DATABASE_APP_URL: database.url('crm_app'),
      ...signIn,
      SECRETS_PUBLIC_KEY: '1:public-t-e6gRqjLUQ4UM7RYCMR4JA7W9P_LWS0JxazOyop7GE',
      // A request without a session acts for their business.
      DEV_TENANT_CONTEXT: JSON.stringify({
        agencyId: agency.id,
        businessId: northwind.id,
        userId: dana.id,
      }),
    });
    stops.push(otherBusiness.stop);

    // Checkpoint 1A starts with no fixture people or businesses. Run the install's real
    // entry point, then consume the first-admin link the app prints, as an operator does.
    // Share the already-running Postgres and Mailpit so no Docker network starts while
    // browsers are navigating (see README); the database itself is isolated.
    const fresh = await testDatabase(postgres.connection);
    stops.push(() => fresh.close());
    await promisify(execFile)(process.execPath, ['dist/install.js'], {
      cwd: serverDirectory,
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_OWNER_URL: fresh.url('crm_owner'),
        AGENCY_NAME: 'Checkpoint Agency',
      },
      timeout: 60_000,
    });
    const freshApp = await startServer('fresh-install', {
      ROLE: 'app',
      ...signIn,
      DATABASE_APP_URL: fresh.url('crm_app'),
      DATABASE_AUTH_URL: fresh.url('crm_auth'),
      DASHBOARD_DIR: dashboardDirectory,
      TRUST_PROXY: 'loopback',
      SECRETS_PUBLIC_KEY: '1:public-t-e6gRqjLUQ4UM7RYCMR4JA7W9P_LWS0JxazOyop7GE',
    });
    stops.push(freshApp.stop);
    const deadline = Date.now() + 15_000;
    let setupLink: string | undefined;
    while (setupLink === undefined) {
      const log = await readFile(`${logDirectory}fresh-install.log`, 'utf8');
      setupLink = /"setupLink":"([^"\s]+)"/.exec(log)?.[1];
      if (setupLink !== undefined) break;
      if (Date.now() >= deadline) throw new Error('The fresh install printed no first-admin link.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Checkpoint 1C, "Inbox day": an install of its own, with a mail server to connect a
    // mailbox to (GreenMail: SMTP and IMAP over TLS) and a stand-in for Twilio. Its server
    // is inbox-day-server.ts, the image's main.js told where those two are. Text messages
    // need a public https address, so it stands behind an HTTPS front, as an install
    // stands behind Coolify's proxy, and PUBLIC_URL is the front's address.
    const greenMail = await startGreenMail('localhost.test');
    stops.push(greenMail.stop);
    const twilio = await startFakeTwilio();
    stops.push(() => twilio.stop());
    const day = await testDatabase(postgres.connection);
    stops.push(() => day.close());
    const dayAgency = await day.fixtures.agency({ name: 'Bluebird Digital' });
    const lakeside = await day.fixtures.business(dayAgency.id, inboxDay.business);
    await seedOwner(day, dayAgency.id, lakeside.id, inboxDay.owner);
    const frontPort = await freePort();
    const dayApp = await startServer(
      'inbox-day',
      {
        ROLE: 'all',
        ...signIn,
        DATABASE_APP_URL: day.url('crm_app'),
        DATABASE_WORKER_URL: day.url('crm_worker'),
        DATABASE_AUTH_URL: day.url('crm_auth'),
        SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        DASHBOARD_DIR: dashboardDirectory,
        TRUST_PROXY: 'loopback',
        PUBLIC_INTAKE_SECRET: 'an-end-to-end-public-intake-secret-of-32-bytes-or-more',
        PUBLIC_URL: `https://localhost:${String(frontPort)}`,
        E2E_TWILIO_URL: twilio.origin,
        E2E_MAIL_ADDRESS: greenMail.server.address,
        E2E_MAIL_CA: greenMail.server.ca,
      },
      fileURLToPath(new URL('inbox-day-server.ts', import.meta.url)),
    );
    stops.push(dayApp.stop);
    const front = await startHttpsFront(frontPort, dayApp.port, greenMail.server.tlsContext);
    stops.push(() => front.stop());
    const mailServer: InboxDayMailServer = {
      address: greenMail.server.address,
      smtpPort: greenMail.server.smtpPort,
      imapPort: greenMail.server.imapPort,
      plainSmtpPort: greenMail.server.smtpStarttlsPort,
      username: greenMail.server.username,
      password: greenMail.server.password,
      apiUrl: greenMail.server.apiUrl,
    };

    // Checkpoint 1E, "Automation day": an install of its own again, set up as Inbox day's
    // is, so that what its automations send goes to the same two stand-ins and nowhere
    // else. Its own database and its own public address; the mail server and the Twilio
    // stand-in are shared, and each test makes its own Twilio account.
    const flow = await testDatabase(postgres.connection);
    stops.push(() => flow.close());
    const flowAgency = await flow.fixtures.agency({ name: 'Bluebird Digital' });
    const meadow = await flow.fixtures.business(flowAgency.id, automationDay.business);
    await seedOwner(flow, flowAgency.id, meadow.id, automationDay.owner);
    const flowFrontPort = await freePort();
    const flowApp = await startServer(
      'automation-day',
      {
        ROLE: 'all',
        ...signIn,
        DATABASE_APP_URL: flow.url('crm_app'),
        DATABASE_WORKER_URL: flow.url('crm_worker'),
        DATABASE_AUTH_URL: flow.url('crm_auth'),
        SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        DASHBOARD_DIR: dashboardDirectory,
        TRUST_PROXY: 'loopback',
        PUBLIC_INTAKE_SECRET: 'an-end-to-end-public-intake-secret-of-32-bytes-or-more',
        PUBLIC_URL: `https://localhost:${String(flowFrontPort)}`,
        E2E_TWILIO_URL: twilio.origin,
        E2E_MAIL_ADDRESS: greenMail.server.address,
        E2E_MAIL_CA: greenMail.server.ca,
      },
      fileURLToPath(new URL('inbox-day-server.ts', import.meta.url)),
    );
    stops.push(flowApp.stop);
    const flowFront = await startHttpsFront(
      flowFrontPort,
      flowApp.port,
      greenMail.server.tlsContext,
    );
    stops.push(() => flowFront.stop());

    // Checkpoint 1D, "Booking day": an install of its own once more, because a booking
    // sends its confirmation from a connected mailbox, and only a server told where the
    // mail stand-in is can connect one (inbox-day-server.ts). Nothing here needs https, so
    // it is reached at its own address, as the main server is.
    const stay = await testDatabase(postgres.connection);
    stops.push(() => stay.close());
    const stayAgency = await stay.fixtures.agency({ name: 'Bluebird Digital' });
    const juniper = await stay.fixtures.business(stayAgency.id, bookingDay.business);
    await seedOwner(stay, stayAgency.id, juniper.id, bookingDay.owner);
    const stayApp = await startServer(
      'booking-day',
      {
        ROLE: 'all',
        ...signIn,
        DATABASE_APP_URL: stay.url('crm_app'),
        DATABASE_WORKER_URL: stay.url('crm_worker'),
        DATABASE_AUTH_URL: stay.url('crm_auth'),
        SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        DASHBOARD_DIR: dashboardDirectory,
        TRUST_PROXY: 'loopback',
        PUBLIC_INTAKE_SECRET: 'an-end-to-end-public-intake-secret-of-32-bytes-or-more',
        E2E_TWILIO_URL: twilio.origin,
        E2E_MAIL_ADDRESS: greenMail.server.address,
        E2E_MAIL_CA: greenMail.server.ca,
      },
      fileURLToPath(new URL('inbox-day-server.ts', import.meta.url)),
    );
    stops.push(stayApp.stop);

    // Settings → AI models, "Model day": an install of its own, whose worker is told where
    // Claude is (a local stand-in) and whose operator has listed two model servers: that
    // stand-in, which the transport would otherwise refuse as a private address, and a
    // stand-in for a model server of the install's own. No test reaches a real provider.
    const claude = await startFakeClaude(modelDay.claudeKey);
    stops.push(() => claude.stop());
    const modelServer = await startFakeOpenAi(null);
    stops.push(() => modelServer.stop());
    const models = await testDatabase(postgres.connection);
    stops.push(() => models.close());
    const modelAgency = await models.fixtures.agency({ name: 'Bluebird Digital' });
    const fernbank = await models.fixtures.business(modelAgency.id, modelDay.business);
    await seedOwner(models, modelAgency.id, fernbank.id, modelDay.owner);
    const modelApp = await startServer(
      'model-day',
      {
        ROLE: 'all',
        ...signIn,
        DATABASE_APP_URL: models.url('crm_app'),
        DATABASE_WORKER_URL: models.url('crm_worker'),
        DATABASE_AUTH_URL: models.url('crm_auth'),
        SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        DASHBOARD_DIR: dashboardDirectory,
        TRUST_PROXY: 'loopback',
        AI_LOCAL_SERVERS: `${claude.hostPort},${modelServer.hostPort}`,
        E2E_CLAUDE_URL: claude.origin,
        E2E_TWILIO_URL: twilio.origin,
        E2E_MAIL_ADDRESS: greenMail.server.address,
        E2E_MAIL_CA: greenMail.server.ca,
      },
      fileURLToPath(new URL('inbox-day-server.ts', import.meta.url)),
    );
    stops.push(modelApp.stop);

    // The assistant's reply drafts, "Draft day": an install of its own once more, which
    // needs both of the worlds above. Mail arrives through the test run's mail server, and
    // the draft is written by a stand-in for Claude of its own, which its tests script.
    const draftClaude = await startFakeClaude(draftDay.claudeKey);
    stops.push(() => draftClaude.stop());
    const drafts = await testDatabase(postgres.connection);
    stops.push(() => drafts.close());
    const draftAgency = await drafts.fixtures.agency({ name: 'Bluebird Digital' });
    const willow = await drafts.fixtures.business(draftAgency.id, draftDay.business);
    await seedOwner(drafts, draftAgency.id, willow.id, draftDay.owner);
    const draftApp = await startServer(
      'draft-day',
      {
        ROLE: 'all',
        ...signIn,
        DATABASE_APP_URL: drafts.url('crm_app'),
        DATABASE_WORKER_URL: drafts.url('crm_worker'),
        DATABASE_AUTH_URL: drafts.url('crm_auth'),
        SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        DASHBOARD_DIR: dashboardDirectory,
        TRUST_PROXY: 'loopback',
        AI_LOCAL_SERVERS: draftClaude.hostPort,
        E2E_CLAUDE_URL: draftClaude.origin,
        E2E_TWILIO_URL: twilio.origin,
        E2E_MAIL_ADDRESS: greenMail.server.address,
        E2E_MAIL_CA: greenMail.server.ca,
      },
      fileURLToPath(new URL('inbox-day-server.ts', import.meta.url)),
    );
    stops.push(draftApp.stop);

    // Email verification, "Verify day": an install of its own, whose server is told where
    // Emailable is (a local stand-in) and answers DNS itself, and whose mailbox is the test
    // run's mail server, so an address found invalid can be shown to stop a reply.
    const emailable = await startFakeEmailable(verifyDay.emailableKey);
    stops.push(() => emailable.stop());
    const checks = await testDatabase(postgres.connection);
    stops.push(() => checks.close());
    const checksAgency = await checks.fixtures.agency({ name: 'Bluebird Digital' });
    const birchwood = await checks.fixtures.business(checksAgency.id, verifyDay.business);
    await seedOwner(checks, checksAgency.id, birchwood.id, verifyDay.owner);
    const bulkAgency = await checks.fixtures.agency({ name: 'Bulk Verification Digital' });
    const bulkBusiness = await checks.fixtures.business(bulkAgency.id, bulkVerifyDay.business);
    await seedOwner(checks, bulkAgency.id, bulkBusiness.id, bulkVerifyDay.owner);
    // Settings → Integrations on the same install: a business of its own, and the stand-in
    // provider its server is told about, with the account the consent page signs in as.
    const provider = await startFakeProvider();
    stops.push(() => provider.close());
    provider.addAccount(integrationsDay.account);
    const cedarAgency = await checks.fixtures.agency({ name: 'Cedar Hollow Digital' });
    const cedar = await checks.fixtures.business(cedarAgency.id, integrationsDay.business);
    await seedOwner(checks, cedarAgency.id, cedar.id, integrationsDay.owner);
    const checksApp = await startServer(
      'verify-day',
      {
        ROLE: 'all',
        ...signIn,
        DATABASE_APP_URL: checks.url('crm_app'),
        DATABASE_WORKER_URL: checks.url('crm_worker'),
        DATABASE_AUTH_URL: checks.url('crm_auth'),
        SECRETS_KEYS: '1:private-dev-only-vault-key-not-for-production-use-0',
        DASHBOARD_DIR: dashboardDirectory,
        TRUST_PROXY: 'loopback',
        E2E_EMAILABLE_URL: emailable.origin,
        E2E_INTEGRATION_URL: provider.origin,
        E2E_TWILIO_URL: twilio.origin,
        E2E_MAIL_ADDRESS: greenMail.server.address,
        E2E_MAIL_CA: greenMail.server.ca,
      },
      fileURLToPath(new URL('inbox-day-server.ts', import.meta.url)),
    );
    stops.push(checksApp.stop);

    process.env[variables.verifyDay] = checksApp.url;
    process.env[variables.integrationProvider] = provider.origin;
    process.env[variables.verifyDayDatabase] = checks.url('crm_owner');
    process.env[variables.draftDay] = draftApp.url;
    process.env[variables.draftDayDatabase] = drafts.url('crm_owner');
    process.env[variables.draftDayClaude] = draftClaude.origin;
    process.env[variables.modelDay] = modelApp.url;
    process.env[variables.modelDayDatabase] = models.url('crm_owner');
    process.env[variables.modelServer] = `${modelServer.origin}/v1`;
    process.env[variables.bookingDay] = stayApp.url;
    process.env[variables.bookingDayDatabase] = stay.url('crm_owner');
    process.env[variables.automationDay] = flowFront.url;
    process.env[variables.automationDayDirect] = `http://127.0.0.1:${String(flowApp.port)}`;
    process.env[variables.automationDayDatabase] = flow.url('crm_owner');
    process.env[variables.inboxDay] = front.url;
    process.env[variables.inboxDayDirect] = `http://127.0.0.1:${String(dayApp.port)}`;
    process.env[variables.inboxDayDatabase] = day.url('crm_owner');
    process.env[variables.twilio] = twilio.origin;
    process.env[variables.mailServer] = JSON.stringify(mailServer);
    process.env[variables.app] = app.url;
    process.env[variables.freshApp] = freshApp.url;
    process.env[variables.freshSetupLink] = setupLink;
    process.env[variables.otherBusiness] = otherBusiness.url;
    process.env[variables.database] = database.url('crm_owner');
    process.env[variables.mail] = mailpit.server.apiUrl;
    return stopAll;
  } catch (error) {
    await stopAll().catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], 'Starting the test run failed.');
    });
    throw error;
  }
}
