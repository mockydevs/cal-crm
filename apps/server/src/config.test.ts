import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const DATABASE_APP_URL = 'postgres://crm_app:secret@db:5432/crm';
const DATABASE_WORKER_URL = 'postgres://crm_worker:secret@db:5432/crm';
const PUBLIC_URL = 'https://crm.example.com';
// What signing in needs, in the roles that serve the API; every role needs PUBLIC_URL.
const SIGN_IN = {
  DATABASE_AUTH_URL: 'postgres://crm_auth:secret@db:5432/crm',
  AUTH_SECRET: 'a-secret-of-at-least-32-characters!',
  PUBLIC_URL,
  SMTP_URL: 'smtps://crm@bluebird.example:secret@smtp.bluebird.example:465',
  MAIL_FROM: 'Bluebird Digital <crm@bluebird.example>',
};
// What files need, in the roles that serve the API.
const FILES = {
  FILES_DIR: '/data/files',
  FILES_LINK_SECRET: 'a-files-link-secret-of-32-characters',
};
// The vault's keys: the private keys in the roles that run the worker, the public key alone
// in the app role. Neither is .env.example's.
const PRIVATE_KEYS = { SECRETS_KEYS: `2:private-${'b'.repeat(42)}A,1:private-${'a'.repeat(42)}A` };
const PUBLIC_KEY = { SECRETS_PUBLIC_KEY: `2:public-${'c'.repeat(42)}A` };
const keysFor = (role: string) => (role === 'app' ? PUBLIC_KEY : PRIVATE_KEYS);
const context = {
  agencyId: '01a11403-3ee7-7bb3-90d9-f58f45343f61',
  businessId: '01a11403-3ee7-7bb3-90d9-f58f45343f62',
  userId: '01a11403-3ee7-7bb3-90d9-f58f45343f63',
};

function errorOf(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected the configuration to be refused');
}

describe('loadConfig', () => {
  it('accepts only fixed voice-worker origins and leaves the relay disabled when unset', () => {
    const env = { ROLE: 'app', DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PUBLIC_KEY };
    expect(loadConfig(env).voiceWorkerOrigin).toBeUndefined();
    for (const origin of [
      'http://worker:3000',
      'http://127.0.0.1:3001',
      'https://worker.example.test',
    ])
      expect(loadConfig({ ...env, VOICE_WORKER_ORIGIN: origin }).voiceWorkerOrigin).toBe(origin);
    for (const origin of [
      'http://evil.test',
      'https://worker.test/path',
      'https://user:private@worker.test',
      'https://worker.test?query=1',
      'https://worker.test#fragment',
    ])
      expect(errorOf({ ...env, VOICE_WORKER_ORIGIN: origin }).variables).toContain(
        'VOICE_WORKER_ORIGIN',
      );
  });
  describe('public intake secret', () => {
    const app = { ROLE: 'app', DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PUBLIC_KEY };

    it('leaves public intake disabled without a secret or with an empty Compose setting', () => {
      expect(loadConfig(app).publicIntake).toBeUndefined();
      expect(loadConfig({ ...app, PUBLIC_INTAKE_SECRET: '' }).publicIntake).toBeUndefined();
      // A CDN's own time for a site page: none unless it is set, and never a long one.
      expect(loadConfig(app).sitesSharedCacheSeconds).toBeUndefined();
      for (const unset of ['', '0'])
        expect(
          loadConfig({ ...app, SITES_SHARED_CACHE_SECONDS: unset }).sitesSharedCacheSeconds,
        ).toBeUndefined();
      expect(loadConfig({ ...app, SITES_SHARED_CACHE_SECONDS: '60' }).sitesSharedCacheSeconds).toBe(
        60,
      );
      for (const wrong of ['-1', '301', '1.5', 'soon'])
        expect(errorOf({ ...app, SITES_SHARED_CACHE_SECONDS: wrong }).variables).toEqual([
          'SITES_SHARED_CACHE_SECONDS',
        ]);
      // How many rendered pages a process keeps: the default unless set, none when 0.
      expect(
        loadConfig({ ...app, SITES_PAGE_CACHE_PAGES: '' }).sitesPageCachePages,
      ).toBeUndefined();
      expect(loadConfig({ ...app, SITES_PAGE_CACHE_PAGES: '0' }).sitesPageCachePages).toBe(0);
      expect(loadConfig({ ...app, SITES_PAGE_CACHE_PAGES: '2000' }).sitesPageCachePages).toBe(2000);
      for (const wrong of ['-1', '10001', 'many'])
        expect(errorOf({ ...app, SITES_PAGE_CACHE_PAGES: wrong }).variables).toEqual([
          'SITES_PAGE_CACHE_PAGES',
        ]);
    });

    it('keeps the dedicated shared secret in app configuration', () => {
      const secret = 'test-only-public-intake-key-0123456789';
      expect(loadConfig({ ...app, PUBLIC_INTAKE_SECRET: secret }).publicIntake).toEqual({ secret });
    });

    it('validates UTF-8 bytes without echoing an invalid secret', () => {
      const secret = 'é'.repeat(16);
      expect(loadConfig({ ...app, PUBLIC_INTAKE_SECRET: secret }).publicIntake).toEqual({ secret });
      const error = errorOf({ ...app, PUBLIC_INTAKE_SECRET: 'private-short-key' });
      expect(error.variables).toEqual(['PUBLIC_INTAKE_SECRET']);
      expect(error.message).toContain('32 bytes');
      expect(error.message).not.toContain('private-short-key');
    });

    it('rejects a public development example in production', () => {
      const error = errorOf({
        ...app,
        NODE_ENV: 'production',
        PUBLIC_INTAKE_SECRET: 'dev-only-public-intake-key-0123456789',
      });
      expect(error.variables).toEqual(['PUBLIC_INTAKE_SECRET']);
      expect(error.message).toContain('must be your own secret in production');
      expect(error.message).not.toContain('0123456789');
    });

    it('gives a worker the secret only as the key of reminder links', () => {
      const worker = loadConfig({
        ROLE: 'worker',
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        PUBLIC_URL,
        ...PRIVATE_KEYS,
        PUBLIC_INTAKE_SECRET: 'test-only-public-intake-key-0123456789',
      });
      expect(worker.publicIntake).toBeUndefined();
      expect(worker.appointmentLinkSecret).toBe('test-only-public-intake-key-0123456789');
      expect(loadConfig(app).appointmentLinkSecret).toBeUndefined();
    });
  });

  it('treats an empty Compose mailbox selection as bootstrap delivery', () => {
    expect(
      loadConfig({
        ROLE: 'app',
        DATABASE_APP_URL,
        ...SIGN_IN,
        ...FILES,
        ...PUBLIC_KEY,
        SYSTEM_MAILBOX: '',
      }).systemMailbox,
    ).toBeUndefined();
  });
  it("reads the agency's campaign ceiling, and has none when it is left empty", () => {
    const base = { ROLE: 'app', DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PUBLIC_KEY };
    expect(loadConfig({ ...base, CAMPAIGN_AGENCY_DAILY_LIMIT: '20000' })).toMatchObject({
      campaignAgencyDailyLimit: 20000,
    });
    expect(
      loadConfig({ ...base, CAMPAIGN_AGENCY_DAILY_LIMIT: '' }).campaignAgencyDailyLimit,
    ).toBeUndefined();
    expect(() => loadConfig({ ...base, CAMPAIGN_AGENCY_DAILY_LIMIT: '0' })).toThrow();
  });
  it('selects a connected install mailbox without requiring bootstrap SMTP credentials', () => {
    const { SMTP_URL: _smtp, MAIL_FROM: _from, ...authentication } = SIGN_IN;
    const config = loadConfig({
      ROLE: 'app',
      DATABASE_APP_URL,
      ...authentication,
      ...FILES,
      ...PUBLIC_KEY,
      SYSTEM_MAILBOX: 'mbx_01k8e2wzr0e008000000000003',
    });
    expect(config.systemMailbox).toBe('019a1c2e-7f00-7000-8000-000000000003');
    expect(config.mail).toBeUndefined();
  });
  it('fills in the defaults', () => {
    expect(
      loadConfig({ DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS }),
    ).toEqual({
      nodeEnv: 'development',
      role: 'all',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      databaseAppUrl: DATABASE_APP_URL,
      databaseWorkerUrl: DATABASE_WORKER_URL,
      databasePoolSize: 10,
      shutdownTimeoutMs: 8000,
      dashboardDir: undefined,
      devTenantContext: undefined,
      vault: {
        holds: 'private',
        keys: [
          { version: 2, key: new Uint8Array(Buffer.from(`${'b'.repeat(42)}A`, 'base64url')) },
          { version: 1, key: new Uint8Array(Buffer.from(`${'a'.repeat(42)}A`, 'base64url')) },
        ],
      },
      publicUrl: PUBLIC_URL,
      authentication: { databaseUrl: SIGN_IN.DATABASE_AUTH_URL, secret: SIGN_IN.AUTH_SECRET },
      mail: { smtpUrl: SIGN_IN.SMTP_URL, from: SIGN_IN.MAIL_FROM },
      trustProxy: [],
      files: {
        storage: { kind: 'local', directory: '/data/files' },
        maxBytes: 26_214_400,
        linkSecret: FILES.FILES_LINK_SECRET,
      },
    });
  });

  it('reads every setting', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      ROLE: 'worker',
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      DATABASE_POOL_SIZE: '4',
      SHUTDOWN_TIMEOUT_MS: '5000',
      DASHBOARD_DIR: '/app/dashboard',
      DEV_TENANT_CONTEXT: JSON.stringify(context),
      PUBLIC_URL,
      TRUST_PROXY: 'uniquelocal, 10.0.1.0/24,203.0.113.7',
      ...PRIVATE_KEYS,
    });
    expect(config).toMatchObject({
      role: 'worker',
      port: 8080,
      databaseWorkerUrl: DATABASE_WORKER_URL,
      databasePoolSize: 4,
      shutdownTimeoutMs: 5000,
      dashboardDir: '/app/dashboard',
      devTenantContext: context,
      trustProxy: ['uniquelocal', '10.0.1.0/24', '203.0.113.7'],
    });
  });

  it('reads the install\u2019s own model servers, and has none until it is told of some', () => {
    const base = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    expect(loadConfig(base)).not.toHaveProperty('aiLocalServers');
    expect(loadConfig({ ...base, AI_LOCAL_SERVERS: '' })).not.toHaveProperty('aiLocalServers');
    expect(
      loadConfig({ ...base, AI_LOCAL_SERVERS: 'ollama:11434, 192.168.1.20:8080' }).aiLocalServers,
    ).toEqual([
      { host: 'ollama', port: 11434 },
      { host: '192.168.1.20', port: 8080 },
    ]);
    // A mistake stops the start, and the message does not repeat what was typed.
    const error = errorOf({ ...base, AI_LOCAL_SERVERS: 'http://secret-host.internal:11434' });
    expect(error.variables).toEqual(['AI_LOCAL_SERVERS']);
    expect(error.message).toContain(
      'AI_LOCAL_SERVERS: must list model servers as host:port, separated by commas, such as ollama:11434',
    );
    expect(error.message).not.toContain('secret-host');
  });

  it("needs the job queue's connection string in the roles that run the worker", () => {
    for (const ROLE of ['worker', 'all']) {
      const error = errorOf({ ROLE, DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS });
      expect(error.variables).toEqual(['DATABASE_WORKER_URL']);
      expect(error.message).toContain('DATABASE_WORKER_URL: required for the worker and all roles');
    }
  });

  it("leaves the job queue's connection string out of the app role", () => {
    const app = { ROLE: 'app', DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PUBLIC_KEY };
    expect(loadConfig(app)).toMatchObject({ databaseWorkerUrl: undefined });
    expect(loadConfig({ ...app, DATABASE_WORKER_URL })).toMatchObject({
      databaseWorkerUrl: undefined,
    });
  });

  it('needs what signing in needs in the roles that serve the API, and not in the worker', () => {
    for (const ROLE of ['app', 'all']) {
      const error = errorOf({
        ROLE,
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        PUBLIC_URL,
        ...FILES,
        ...keysFor(ROLE),
      });
      expect(error.variables).toEqual([
        'DATABASE_AUTH_URL',
        'AUTH_SECRET',
        'SMTP_URL',
        'MAIL_FROM',
      ]);
      expect(error.message).toContain('DATABASE_AUTH_URL: required for the app and all roles');
    }
    expect(
      loadConfig({
        ROLE: 'worker',
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        PUBLIC_URL,
        ...PRIVATE_KEYS,
      }),
    ).toMatchObject({ publicUrl: PUBLIC_URL, authentication: undefined, mail: undefined });
  });

  it('takes an SMTP address only, for the mail the install sends', () => {
    const env = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    expect(errorOf({ ...env, SMTP_URL: 'https://smtp.example.com' }).variables).toEqual([
      'SMTP_URL',
    ]);
    expect(loadConfig({ ...env, SMTP_URL: 'smtp://127.0.0.1:1025' }).mail?.smtpUrl).toBe(
      'smtp://127.0.0.1:1025',
    );
  });

  it('needs the public address in every role, for links in emails too', () => {
    for (const ROLE of ['app', 'worker', 'all']) {
      const { PUBLIC_URL: _none, ...withoutAddress } = SIGN_IN;
      expect(
        errorOf({
          ROLE,
          DATABASE_APP_URL,
          DATABASE_WORKER_URL,
          ...withoutAddress,
          ...FILES,
          ...keysFor(ROLE),
        }).variables,
      ).toEqual(['PUBLIC_URL']);
    }
  });

  it('refuses a short secret, a public address with a path, and plain HTTP in production', () => {
    expect(
      errorOf({
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        ...SIGN_IN,
        ...FILES,
        ...PRIVATE_KEYS,
        AUTH_SECRET: 'too short',
      }).variables,
    ).toEqual(['AUTH_SECRET']);
    expect(
      errorOf({
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        ...SIGN_IN,
        ...FILES,
        ...PRIVATE_KEYS,
        PUBLIC_URL: 'https://example.com/crm',
      }).message,
    ).toContain('PUBLIC_URL: must be the address people use, with no path');
    const production = errorOf({
      NODE_ENV: 'production',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      ...SIGN_IN,
      ...FILES,
      ...PRIVATE_KEYS,
      PUBLIC_URL: 'http://crm.example.com',
    });
    expect(production.variables).toEqual(['PUBLIC_URL']);
    expect(production.message).toContain('must be https:// in production');
    expect(
      loadConfig({
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        ...SIGN_IN,
        ...FILES,
        ...PRIVATE_KEYS,
        PUBLIC_URL: 'http://localhost:5173/',
      }).publicUrl,
    ).toBe('http://localhost:5173');
  });

  it('lists every invalid variable at once, by name', () => {
    const error = errorOf({
      ROLE: 'web',
      PORT: '70000',
      LOG_LEVEL: 'loud',
      SHUTDOWN_TIMEOUT_MS: 'soon',
    });
    expect(error.variables).toEqual([
      'ROLE',
      'PORT',
      'LOG_LEVEL',
      'PUBLIC_URL',
      'DATABASE_APP_URL',
      'SHUTDOWN_TIMEOUT_MS',
    ]);
    expect(
      errorOf({ DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, TRUST_PROXY: '1' }).variables,
    ).toEqual(['TRUST_PROXY']);
    expect(error.message).toMatch(/^The server's configuration is invalid:\n {2}ROLE: /);
    expect(error.message).toContain('\n  DATABASE_APP_URL: ');
  });

  // A list that would let visitors choose their own address refuses to start.
  it('takes cloudflare among the proxies, and refuses ranges wide enough to hold visitors', () => {
    const base = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    expect(loadConfig({ ...base, TRUST_PROXY: '172.18.0.0/16, cloudflare' }).trustProxy).toEqual([
      '172.18.0.0/16',
      'cloudflare',
    ]);
    for (const wide of ['0.0.0.0/0', '128.0.0.0/1', '10.0.0.0/7', '::/0', '2000::/3', 'fd00::/8']) {
      const error = errorOf({ ...base, TRUST_PROXY: `loopback,${wide}` });
      expect(error.variables).toEqual(['TRUST_PROXY']);
      expect(error.message).toContain(`${wide} is wider than`);
    }
    expect(errorOf({ ...base, TRUST_PROXY: '::ffff:0:0/96' }).message).toContain(
      'an IPv4 range written as IPv6',
    );
    for (const malformed of ['10.0.0.0/33', '10.0.0.0/8/8', '10.0.0.0/x', 'proxy', '1'])
      expect(errorOf({ ...base, TRUST_PROXY: malformed }).message).toContain(
        `${malformed} is not an address`,
      );
    expect(
      loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8,2001:db8::/16,::ffff:172.18.0.5,fe80::1' })
        .trustProxy,
    ).toHaveLength(4);
  });

  describe('Google Calendar', () => {
    const base = { DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PUBLIC_KEY, ROLE: 'app' };

    it('hides Google without its client, and takes both settings left empty as left out', () => {
      expect(loadConfig(base).google).toBeUndefined();
      expect(
        loadConfig({ ...base, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }).google,
      ).toBeUndefined();
    });

    it('reads the client in the app and the worker', () => {
      const google = {
        GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'GOCSPX-fixture',
      };
      expect(loadConfig({ ...base, ...google }).google).toEqual({
        clientId: '123.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-fixture',
      });
      expect(
        loadConfig({
          DATABASE_APP_URL,
          DATABASE_WORKER_URL,
          PUBLIC_URL,
          ROLE: 'worker',
          ...PRIVATE_KEYS,
          ...google,
        }).google?.clientId,
      ).toBe('123.apps.googleusercontent.com');
    });

    it('refuses one setting without the other, naming the missing one and never a value', () => {
      const withoutSecret = errorOf({ ...base, GOOGLE_CLIENT_ID: 'id-hunter2' });
      expect(withoutSecret.variables).toEqual(['GOOGLE_CLIENT_SECRET']);
      expect(withoutSecret.message).not.toContain('hunter2');
      const withoutId = errorOf({ ...base, GOOGLE_CLIENT_SECRET: 'secret-hunter2' });
      expect(withoutId.variables).toEqual(['GOOGLE_CLIENT_ID']);
      expect(withoutId.message).not.toContain('hunter2');
    });
  });

  it('never repeats a secret in its errors', () => {
    const error = errorOf({ DATABASE_APP_URL: 'not a url with password hunter2' });
    expect(error.message).not.toContain('hunter2');
  });

  it('refuses a stub sign-in context that is not JSON or not complete', () => {
    const env = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    expect(errorOf({ ...env, DEV_TENANT_CONTEXT: '{' }).variables).toEqual(['DEV_TENANT_CONTEXT']);
    expect(
      errorOf({ ...env, DEV_TENANT_CONTEXT: JSON.stringify({ agencyId: 'x' }) }).variables,
    ).toEqual(['DEV_TENANT_CONTEXT']);
  });

  it("refuses the example's secret in production, since it's public", () => {
    const error = errorOf({
      NODE_ENV: 'production',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      ...SIGN_IN,
      ...FILES,
      ...PRIVATE_KEYS,
      AUTH_SECRET: 'dev-only-secret-for-this-machine-only',
    });
    expect(error.variables).toEqual(['AUTH_SECRET']);
    expect(error.message).toContain('AUTH_SECRET: must be your own secret in production');
  });

  it('refuses a stub sign-in context in production', () => {
    const error = errorOf({
      NODE_ENV: 'production',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      ...SIGN_IN,
      ...FILES,
      ...PRIVATE_KEYS,
      DEV_TENANT_CONTEXT: JSON.stringify(context),
    });
    expect(error.variables).toEqual(['DEV_TENANT_CONTEXT']);
    expect(error.message).toContain('not allowed in production');
  });

  it('keeps the sign-in limit on unless development switches it off', () => {
    const env = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    expect(loadConfig(env).signInLimit).toBeUndefined();
    expect(loadConfig({ ...env, DEV_SIGN_IN_LIMIT: 'off' }).signInLimit).toBe(false);
    expect(errorOf({ ...env, DEV_SIGN_IN_LIMIT: 'no' }).variables).toEqual(['DEV_SIGN_IN_LIMIT']);
  });

  it('refuses a sign-in limit switched off in production', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      ...SIGN_IN,
      ...FILES,
      ...PRIVATE_KEYS,
    };
    expect(loadConfig({ ...production, DEV_SIGN_IN_LIMIT: 'on' }).signInLimit).toBeUndefined();
    const error = errorOf({ ...production, DEV_SIGN_IN_LIMIT: 'off' });
    expect(error.variables).toEqual(['DEV_SIGN_IN_LIMIT']);
    expect(error.message).toContain('not allowed in production');
  });

  it('takes S3 settings left empty as left out, as compose.yml passes them', () => {
    const env = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    const blank = {
      FILES_S3_ENDPOINT: '',
      FILES_S3_REGION: '',
      FILES_S3_BUCKET: '',
      FILES_S3_ACCESS_KEY_ID: '',
      FILES_S3_SECRET_ACCESS_KEY: '',
    };
    expect(loadConfig({ ...env, ...blank }).files).toEqual(loadConfig(env).files);
    // Chosen but not filled in is still refused, by name.
    expect(errorOf({ ...env, ...blank, FILES_STORAGE: 's3' }).variables).toContain(
      'FILES_S3_BUCKET',
    );
  });

  it('reads S3 storage, and a limit of its own', () => {
    const s3 = {
      FILES_STORAGE: 's3',
      FILES_S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
      FILES_S3_REGION: 'eu-central-003',
      FILES_S3_BUCKET: 'crm-files',
      FILES_S3_ACCESS_KEY_ID: 'key-id',
      FILES_S3_SECRET_ACCESS_KEY: 'secret-key',
      FILES_S3_PATH_STYLE: 'true',
      FILES_MAX_BYTES: '1048576',
      FILES_LINK_SECRET: FILES.FILES_LINK_SECRET,
    };
    expect(
      loadConfig({ DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...s3, ...PRIVATE_KEYS })
        .files,
    ).toEqual({
      storage: {
        kind: 's3',
        endpoint: s3.FILES_S3_ENDPOINT,
        region: s3.FILES_S3_REGION,
        bucket: s3.FILES_S3_BUCKET,
        accessKeyId: s3.FILES_S3_ACCESS_KEY_ID,
        secretAccessKey: s3.FILES_S3_SECRET_ACCESS_KEY,
        pathStyle: true,
      },
      maxBytes: 1_048_576,
      linkSecret: FILES.FILES_LINK_SECRET,
    });
    const { FILES_S3_PATH_STYLE: _default, ...virtualHosted } = s3;
    expect(
      loadConfig({
        DATABASE_APP_URL,
        DATABASE_WORKER_URL,
        ...SIGN_IN,
        ...virtualHosted,
        ...PRIVATE_KEYS,
      }).files?.storage,
    ).toMatchObject({ pathStyle: false });
  });

  it('needs what files need in the roles that serve the API, and takes them in the worker when given', () => {
    for (const ROLE of ['app', 'all']) {
      const env = { ROLE, DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...keysFor(ROLE) };
      expect(errorOf(env).variables).toEqual(['FILES_DIR', 'FILES_LINK_SECRET']);
      expect(errorOf({ ...env, ...FILES, FILES_STORAGE: 's3' }).variables).toEqual([
        'FILES_S3_ENDPOINT',
        'FILES_S3_REGION',
        'FILES_S3_BUCKET',
        'FILES_S3_ACCESS_KEY_ID',
        'FILES_S3_SECRET_ACCESS_KEY',
      ]);
    }
    const worker = {
      ROLE: 'worker',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      PUBLIC_URL,
      ...PRIVATE_KEYS,
    };
    // A worker without them starts as before: it runs everything but imports.
    expect(loadConfig(worker).files).toBeUndefined();
    expect(loadConfig({ ...worker, FILES_DIR: FILES.FILES_DIR }).files).toBeUndefined();
    // With the app's own settings it reads and writes the same stored files.
    expect(loadConfig({ ...worker, ...FILES }).files).toEqual(
      loadConfig({ DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS })
        .files,
    );
  });

  it('refuses a short link secret, an odd limit, and unknown storage', () => {
    const env = { DATABASE_APP_URL, DATABASE_WORKER_URL, ...SIGN_IN, ...FILES, ...PRIVATE_KEYS };
    expect(errorOf({ ...env, FILES_LINK_SECRET: 'too short' }).variables).toEqual([
      'FILES_LINK_SECRET',
    ]);
    expect(errorOf({ ...env, FILES_MAX_BYTES: '0' }).variables).toEqual(['FILES_MAX_BYTES']);
    expect(errorOf({ ...env, FILES_STORAGE: 'ftp' }).variables).toEqual(['FILES_STORAGE']);
    expect(errorOf({ ...env, FILES_S3_PATH_STYLE: 'yes' }).variables).toEqual([
      'FILES_S3_PATH_STYLE',
    ]);
  });

  it("refuses the example's link secret in production, since it's public", () => {
    const error = errorOf({
      NODE_ENV: 'production',
      DATABASE_APP_URL,
      DATABASE_WORKER_URL,
      ...SIGN_IN,
      ...FILES,
      ...PRIVATE_KEYS,
      FILES_LINK_SECRET: 'dev-only-files-link-secret-for-this-machine',
    });
    expect(error.variables).toEqual(['FILES_LINK_SECRET']);
    expect(error.message).toContain('FILES_LINK_SECRET: must be your own secret in production');
  });

  describe('migrating on start', () => {
    const worker = { ROLE: 'worker', DATABASE_APP_URL, DATABASE_WORKER_URL, PUBLIC_URL };

    it('lets the worker migrate before it starts, and leaves it off by default', () => {
      expect(loadConfig({ ...worker, ...PRIVATE_KEYS }).migrateOnStart).toBeUndefined();
      expect(
        loadConfig({ ...worker, ...PRIVATE_KEYS, MIGRATE_ON_START: 'true' }).migrateOnStart,
      ).toBe(true);
      expect(errorOf({ ...worker, ...PRIVATE_KEYS, MIGRATE_ON_START: 'yes' }).variables).toEqual([
        'MIGRATE_ON_START',
      ]);
    });

    it("refuses it in the app role, which never holds crm_owner's password", () => {
      const app = { ROLE: 'app', DATABASE_APP_URL, ...SIGN_IN, ...FILES, ...PUBLIC_KEY };
      const error = errorOf({ ...app, MIGRATE_ON_START: 'true' });
      expect(error.variables).toEqual(['MIGRATE_ON_START']);
      expect(error.message).toContain('the worker migrates');
    });
  });

  describe("the vault's keys", () => {
    const worker = { ROLE: 'worker', DATABASE_APP_URL, DATABASE_WORKER_URL, PUBLIC_URL };
    const app = { ROLE: 'app', DATABASE_APP_URL, ...SIGN_IN, ...FILES };

    it('gives the private keys to the roles that run the worker, the current one first', () => {
      for (const ROLE of ['worker', 'all']) {
        const config = loadConfig({ ...worker, ...SIGN_IN, ...FILES, ROLE, ...PRIVATE_KEYS });
        expect(config.vault).toMatchObject({
          holds: 'private',
          keys: [{ version: 2 }, { version: 1 }],
        });
      }
    });

    it('gives the app role the public key alone', () => {
      expect(loadConfig({ ...app, ...PUBLIC_KEY }).vault).toEqual({
        holds: 'public',
        publicKey: {
          version: 2,
          publicKey: new Uint8Array(Buffer.from(`${'c'.repeat(42)}A`, 'base64url')),
        },
      });
    });

    it('needs the private keys in the roles that run the worker', () => {
      for (const ROLE of ['worker', 'all']) {
        const error = errorOf({ ...worker, ...SIGN_IN, ...FILES, ROLE, ...PUBLIC_KEY });
        expect(error.variables).toEqual(['SECRETS_KEYS']);
        expect(error.message).toContain('SECRETS_KEYS: required for the worker and all roles');
      }
    });

    it('needs the public key in the app role, and refuses the private keys there', () => {
      expect(errorOf(app).message).toContain('SECRETS_PUBLIC_KEY: required for the app role');
      const given = errorOf({ ...app, ...PUBLIC_KEY, ...PRIVATE_KEYS });
      expect(given.variables).toEqual(['SECRETS_KEYS']);
      expect(given.message).toContain('SECRETS_KEYS: not allowed in the app role');
    });

    it('refuses a malformed key without repeating it', () => {
      const error = errorOf({ ...worker, SECRETS_KEYS: '1:not-a-key-hunter2' });
      expect(error.variables).toEqual(['SECRETS_KEYS']);
      expect(error.message).toContain('SECRETS_KEYS: key version 1 must be private- and 43');
      expect(error.message).not.toContain('hunter2');
      expect(errorOf({ ...app, SECRETS_PUBLIC_KEY: '1:a,2:b' }).variables).toEqual([
        'SECRETS_PUBLIC_KEY',
      ]);
      // The worker's key, pasted as the app's: refused, so the app never holds it.
      const pasted = errorOf({ ...app, SECRETS_PUBLIC_KEY: `2:private-${'b'.repeat(42)}A` });
      expect(pasted.message).toContain('SECRETS_PUBLIC_KEY: holds a private key');
      expect(pasted.message).not.toContain('b'.repeat(42));
    });

    it("refuses the example's keys in production, since they're public", () => {
      const production = { NODE_ENV: 'production' };
      const workerError = errorOf({
        ...worker,
        ...production,
        SECRETS_KEYS: `2:private-${'b'.repeat(42)}A,1:private-dev-only-vault-key-not-for-production-use-0`,
      });
      expect(workerError.variables).toEqual(['SECRETS_KEYS']);
      expect(workerError.message).toContain('SECRETS_KEYS: must be your own keys in production');
      const appError = errorOf({
        ...app,
        ...production,
        SECRETS_PUBLIC_KEY: '1:public-t-e6gRqjLUQ4UM7RYCMR4JA7W9P_LWS0JxazOyop7GE',
      });
      expect(appError.variables).toEqual(['SECRETS_PUBLIC_KEY']);
      expect(appError.message).toContain('SECRETS_PUBLIC_KEY: must be your own key in production');
    });
  });
});
