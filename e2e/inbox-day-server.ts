// The server of the "Inbox day" stack (global-setup.ts runs it with Node, which reads
// TypeScript without a build; keep to syntax that needs none). It is main.ts with one
// difference: the same configuration from the environment, the same routes and worker
// tasks, started by the same start(), and told where the world outside is. A test must
// never reach a real mail provider or Twilio, and the install has no setting that would
// point it elsewhere, so the stand-ins are given here:
//
// - mail servers: the test run's GreenMail, reached as "localhost", trusted by its own
//   certificate. An install refuses private addresses and unknown certificates;
// - Twilio: the transport's requests go to the local stand-in (apps/server/test/fake-twilio.ts);
// - DNS for mailbox checks: one MX record, and nothing else, so no question leaves the machine;
// - Claude, on the "Model day" and "Draft day" installs (E2E_CLAUDE_URL): a key for
//   Anthropic goes to the local stand-in (apps/server/test/fake-claude.ts). The stand-in's
//   host and port are also in AI_LOCAL_SERVERS, as an operator lists a model server,
//   because the transport calls no private address that is not;
// - Emailable, on the "Verify day" install (E2E_EMAILABLE_URL): the adapter asks Emailable's
//   own address, a constant, with the global fetch, so requests for that address go to the
//   local stand-in (apps/server/test/fake-emailable.ts) and every other request as before.
//   DNS for an address check is the same one record as for mailbox checks.
import { apiRoutes } from '../apps/server/dist/api-routes.js';
import { loadConfig } from '../apps/server/dist/config.js';
import { start } from '../apps/server/dist/start.js';
import { workerTasks } from '../apps/server/dist/worker-tasks.js';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} isn't set.`);
  return value;
}

const twilio = need('E2E_TWILIO_URL');
const mailAddress = need('E2E_MAIL_ADDRESS');
const mailCertificate = need('E2E_MAIL_CA');
const claude = process.env['E2E_CLAUDE_URL'];
const emailable = process.env['E2E_EMAILABLE_URL'];

if (emailable !== undefined && emailable !== '') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const asked = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    return asked.origin === 'https://api.emailable.com'
      ? realFetch(new URL(asked.pathname + asked.search, emailable), init)
      : realFetch(input, init);
  };
}

const running = await start(loadConfig(process.env), apiRoutes, workerTasks, {
  mailbox: {
    ca: mailCertificate,
    allowedPrivateHosts: ['localhost'],
    resolve: () => Promise.resolve([mailAddress]),
  },
  twilioFetch: (input, init) => {
    const asked = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    // The transport builds every URL on Twilio's host; anything else is a mistake here.
    if (asked.origin !== 'https://api.twilio.com')
      return Promise.reject(new Error('Only requests for Twilio go to the stand-in.'));
    return fetch(new URL(asked.pathname + asked.search, twilio), init);
  },
  ...(claude === undefined || claude === '' ? {} : { aiBaseUrls: { anthropic: claude } }),
  resolveDns: (_name, type) =>
    type === 'MX'
      ? Promise.resolve([{ exchange: 'mail.localhost.test', priority: 10 }])
      : Promise.reject(Object.assign(new Error('No fixture record.'), { code: 'ENODATA' })),
});

let stopping = false;
async function stop(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await running.stop();
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`Shutdown failed: ${String(error)}\n`);
    process.exit(1);
  }
}
process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(0));
void running.ended.then(() => stop(1));
