// The server's configuration, from environment variables. Everything is checked at start,
// and every problem is reported at once, so a broken install is fixed in one pass.
import {
  parseSecretsKeys,
  parseSecretsPublicKey,
  SecretsKeyError,
  type SecretsKey,
  type SecretsPublicKey,
} from '@repo/module-vault';

import { publicId } from '@repo/contracts';
import { parseLocalServers, type LocalServer } from '@repo/module-ai';
import { parsePublicId } from '@repo/kernel';
import { z } from 'zod';
import { proxyEntryProblem } from './client-address.js';

/** A server-configured origin, never a request URL or forwarded Host. */
export function voiceWorkerOriginOf(value: string): string {
  const url = new URL(value);
  const internal = ['worker', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && internal)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error('The voice worker origin is not valid.');
  return url.origin;
}

export const roles = ['app', 'worker', 'all'] as const;
export type Role = (typeof roles)[number];

/** Who the API acts as until sign-in exists. Never allowed in production. */
export interface DevTenantContext {
  readonly agencyId: string;
  readonly businessId?: string | undefined;
  readonly userId: string;
}

export interface Config {
  /**
   * The install's own model servers, as host and port: the only private or plain-http
   * addresses an AI provider's key may be sent to. Left out when there are none.
   */
  readonly aiLocalServers?: readonly LocalServer[];
  /** Shared HMAC key for public intake. Without it public booking stays unmounted. */
  readonly publicIntake?: { readonly secret: string };
  /**
   * The same secret, for every role, as the key of an appointment reminder's link to
   * reschedule or cancel (migration 0107): the worker writes those links into reminders.
   * Only that: a worker serves no public page, so it has no publicIntake.
   */
  readonly appointmentLinkSecret?: string;
  /**
   * How long a CDN in front of the server may answer for a published site page without
   * asking the server, in seconds (SITES_SHARED_CACHE_SECONDS). Left out: it asks every
   * time. It is also the longest a CDN can go on showing a page after it was unpublished.
   */
  readonly sitesSharedCacheSeconds?: number;
  /**
   * How many rendered site pages each server process keeps in memory, at most
   * (SITES_PAGE_CACHE_PAGES). Left out: 500 (and never more than 64 MiB of them). 0 keeps
   * none: every visit reads the page's rows and renders it.
   */
  readonly sitesPageCachePages?: number;
  /** Trusted install mailbox UUID. Its passwords remain sealed for worker delivery. */
  readonly systemMailbox?: string;
  /**
   * The install's Google OAuth client (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET), for team
   * members' Google Calendars. Left out, Google is hidden. Never logged.
   */
  readonly google?: { readonly clientId: string; readonly clientSecret: string };
  /**
   * The most campaign emails one agency's businesses release in 24 hours, together; left
   * out, there is no such ceiling.
   */
  readonly campaignAgencyDailyLimit?: number;
  readonly nodeEnv: 'development' | 'test' | 'production';
  /** app: the API; worker: background work; all: both, for development and tiny installs. */
  readonly role: Role;
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** crm_app's connection string. */
  readonly databaseAppUrl: string;
  /** crm_worker's, for the job queue: set in the roles that run the worker only. */
  readonly databaseWorkerUrl: string | undefined;
  readonly databasePoolSize: number;
  /** How long shutdown waits for work in flight; under Docker's 10 seconds. */
  readonly shutdownTimeoutMs: number;
  /** The built dashboard, served by the app role when set. */
  readonly dashboardDir: string | undefined;
  readonly devTenantContext: DevTenantContext | undefined;
  /**
   * False only when DEV_SIGN_IN_LIMIT=off, for local work where test scripts sign in over
   * and over; left out otherwise. Refused in production, where the limit is what slows
   * password guessing.
   */
  readonly signInLimit?: false;
  /**
   * True only when MIGRATE_ON_START=true: before it starts, the worker brings the database
   * up to its release, as the migrate container does. For installs where the worker deploys
   * on its own; refused in the app role, which never holds crm_owner's password.
   */
  readonly migrateOnStart?: true;
  /**
   * The address people use, such as https://crm.example.com: for session cookies, the
   * origin the API accepts posts from, and links in emails.
   */
  readonly publicUrl: string;
  /** Fixed private worker HTTP origin for synchronous voice callbacks in app-only role. */
  readonly voiceWorkerOrigin?: string;
  /** Signing in, in the roles that serve the API. */
  readonly authentication: Authentication | undefined;
  /** The install's own mail, such as sign-in links, in the roles that serve the API. */
  readonly mail: Mail | undefined;
  /**
   * The proxies in front, such as Coolify's: addresses, CIDR ranges, the names loopback,
   * linklocal and uniquelocal, and cloudflare. The client's IP is read through them from
   * X-Forwarded-For, and from CF-Connecting-IP at a Cloudflare address, for rate limits and
   * the audit log; with none, it's the peer's (client-address.ts). A hop count can't tell a
   * proxy from a client, so there is none.
   */
  readonly trustProxy: readonly string[];
  /**
   * The files service. The roles that serve the API must have it. The worker has it when it
   * is given the same settings: an import reads its file there, and writes the file of rows
   * it did not apply.
   */
  readonly files: FilesConfig | undefined;
  /** The vault's keys: the worker's private keys, or the app's public key. */
  readonly vault: VaultKeys | undefined;
}

/**
 * Only the roles that run the worker hold the private keys, which open secrets; the app
 * role holds the public key alone, which only seals them.
 */
export type VaultKeys =
  | { readonly holds: 'private'; readonly keys: readonly [SecretsKey, ...SecretsKey[]] }
  | { readonly holds: 'public'; readonly publicKey: SecretsPublicKey };

export interface FilesConfig {
  readonly storage:
    | { readonly kind: 'local'; readonly directory: string }
    | {
        readonly kind: 's3';
        readonly endpoint: string;
        readonly region: string;
        readonly bucket: string;
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
        /** https://endpoint/bucket/key; Garage, MinIO and most self-hosted services want it. */
        readonly pathStyle: boolean;
      };
  /** The largest upload taken, in bytes. */
  readonly maxBytes: number;
  /** Signs download links; used for nothing else. */
  readonly linkSecret: string;
  /** The most one business's live files may add up to, in bytes; left out, no limit. */
  readonly businessQuotaBytes?: number;
}

export interface Mail {
  /** smtp://user:password@host:587 (STARTTLS) or smtps://…:465 (TLS). */
  readonly smtpUrl: string;
  /** Who it's from, such as "Bluebird Digital <crm@bluebird.example>". */
  readonly from: string;
}

export interface Authentication {
  /** crm_auth's connection string. */
  readonly databaseUrl: string;
  /** Signs session cookies and tokens. */
  readonly secret: string;
}

const devTenantContext = z.object({
  agencyId: z.uuid(),
  businessId: z.uuid().optional(),
  userId: z.uuid(),
});

/** Reads a key setting, reporting what's wrong without repeating the key. */
function keySetting<T>(parse: (value: string) => T) {
  return z.string().transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      if (!(error instanceof SecretsKeyError)) throw error;
      ctx.addIssue(error.message);
      return z.NEVER;
    }
  });
}

// .env.example's vault keys, in base64url: anyone can read them.
const EXAMPLE_SECRETS_KEY = 'dev-only-vault-key-not-for-production-use-0';
const EXAMPLE_SECRETS_PUBLIC_KEY = 't-e6gRqjLUQ4UM7RYCMR4JA7W9P_LWS0JxazOyop7GE';
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

const blankAsUnset = (value: unknown): unknown => (value === '' ? undefined : value);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ROLE: z.enum(roles).default('all'),
    HOST: z.string().min(1).default('0.0.0.0'),
    VOICE_WORKER_ORIGIN: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined || value === '') return undefined;
        try {
          return voiceWorkerOriginOf(value);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message:
              'must be an HTTPS origin or a local worker HTTP origin, without credentials, path or query',
          });
          return z.NEVER;
        }
      }),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PUBLIC_URL: z
      .url({
        protocol: /^https?$/,
        error: (issue) =>
          issue.input === undefined
            ? 'required: the address people use, such as https://crm.example.com'
            : 'must be an http:// or https:// address',
      })
      .transform((value, ctx) => {
        const url = new URL(value);
        if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
          ctx.addIssue(
            'must be the address people use, with no path, such as https://crm.example.com',
          );
          return z.NEVER;
        }
        return url.origin;
      }),
    TRUST_PROXY: z
      .string()
      .default('')
      .transform((value, ctx) => {
        const entries = value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');
        // A wrong list refuses to start rather than guess (client-address.ts).
        const problems = entries.map(proxyEntryProblem).filter((problem) => problem !== undefined);
        if (problems.length > 0) {
          ctx.addIssue(
            `must list addresses, CIDR ranges, or loopback, linklocal, uniquelocal or cloudflare, separated by commas: ${problems.join('; ')}`,
          );
          return z.NEVER;
        }
        return entries;
      }),
    AI_LOCAL_SERVERS: z
      .string()
      .default('')
      .transform((value, ctx) => {
        try {
          return parseLocalServers(value);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          ctx.addIssue(
            'must list model servers as host:port, separated by commas, such as ollama:11434',
          );
          return z.NEVER;
        }
      }),
    DATABASE_APP_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_WORKER_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    DATABASE_AUTH_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
    AUTH_SECRET: z.string().min(32, { error: 'must be 32 characters or more' }).optional(),
    // 0 to 300: a page taken down may be shown by a CDN for this long, so it is kept short.
    SITES_SHARED_CACHE_SECONDS: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(0).max(300).optional(),
    ),
    SITES_PAGE_CACHE_PAGES: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(0).max(10_000).optional(),
    ),
    PUBLIC_INTAKE_SECRET: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, {
          error: 'must be 32 bytes or more',
        })
        .optional(),
    ),
    SMTP_URL: z
      .url({ protocol: /^smtps?$/, error: 'must be an smtp:// or smtps:// address' })
      .optional(),
    MAIL_FROM: z.string().min(3).optional(),
    SYSTEM_MAILBOX: z.preprocess(
      (value) => (value === '' ? undefined : value),
      publicId('mailbox')
        .transform((value) => parsePublicId('mailbox', value))
        .optional(),
    ),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(8000),
    DASHBOARD_DIR: z.string().min(1).optional(),
    FILES_STORAGE: z.enum(['local', 's3']).default('local'),
    FILES_DIR: z.string().min(1).optional(),
    // Left empty is the same as left out: compose.yml passes each one on whether or not
    // the install set it.
    FILES_S3_ENDPOINT: z.preprocess(blankAsUnset, z.url({ protocol: /^https?$/ }).optional()),
    FILES_S3_REGION: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    FILES_S3_BUCKET: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    FILES_S3_ACCESS_KEY_ID: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    FILES_S3_SECRET_ACCESS_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    FILES_S3_PATH_STYLE: z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .default('false')
      .transform((value) => value === 'true'),
    // 25 MiB by default; at most 1 GiB, since an upload waits in a temporary file.
    FILES_MAX_BYTES: z.coerce.number().int().min(1).max(1_073_741_824).default(26_214_400),
    // The most one business's files may add up to; left out, there is no limit.
    FILES_BUSINESS_QUOTA_BYTES: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    ),
    FILES_LINK_SECRET: z.string().min(32, { error: 'must be 32 characters or more' }).optional(),
    // One agency's campaign emails in 24 hours; left out, there is no ceiling.
    CAMPAIGN_AGENCY_DAILY_LIMIT: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(1).max(10_000_000).optional(),
    ),
    GOOGLE_CLIENT_ID: z.preprocess(blankAsUnset, z.string().trim().min(1).max(500).optional()),
    GOOGLE_CLIENT_SECRET: z.preprocess(blankAsUnset, z.string().trim().min(1).max(500).optional()),
    SECRETS_KEYS: keySetting(parseSecretsKeys).optional(),
    SECRETS_PUBLIC_KEY: keySetting(parseSecretsPublicKey).optional(),
    DEV_TENANT_CONTEXT: z
      .string()
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          ctx.addIssue('must be JSON: {"agencyId": …, "businessId": …, "userId": …}');
          return z.NEVER;
        }
      })
      .pipe(devTenantContext)
      .optional(),
    DEV_SIGN_IN_LIMIT: z.enum(['on', 'off'], { error: 'must be on or off' }).default('on'),
    MIGRATE_ON_START: z
      .enum(['true', 'false'], { error: 'must be true or false' })
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.MIGRATE_ON_START && env.ROLE === 'app') {
      ctx.addIssue({
        code: 'custom',
        path: ['MIGRATE_ON_START'],
        message:
          "not allowed in the app role: the worker migrates, and the app never holds crm_owner's password",
      });
    }
    // One without the other can't connect anyone: a half-done setup is an error.
    if ((env.GOOGLE_CLIENT_ID === undefined) !== (env.GOOGLE_CLIENT_SECRET === undefined)) {
      const missing =
        env.GOOGLE_CLIENT_ID === undefined ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET';
      ctx.addIssue({
        code: 'custom',
        path: [missing],
        message:
          "required with the other Google setting: the OAuth client's ID and secret go together, or leave both out",
      });
    }
    if (env.ROLE !== 'app' && env.DATABASE_WORKER_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_WORKER_URL'],
        message: "required for the worker and all roles: crm_worker's, for the job queue",
      });
    }
    if (env.ROLE !== 'worker') {
      for (const [variable, what] of [
        ['DATABASE_AUTH_URL', "crm_auth's connection string, for signing in"],
        ['AUTH_SECRET', 'the secret that signs session cookies, 32 characters or more'],
        ['SMTP_URL', 'the mail server for sign-in links and password resets'],
        ['MAIL_FROM', 'who that mail is from, such as "Bluebird Digital <crm@bluebird.example>"'],
      ] as const) {
        if (
          (variable === 'SMTP_URL' || variable === 'MAIL_FROM') &&
          env.SYSTEM_MAILBOX !== undefined
        )
          continue;
        if (env[variable] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [variable],
            message: `required for the app and all roles: ${what}`,
          });
        }
      }
    }
    if (env.ROLE !== 'worker') {
      const needed: [keyof typeof env, string][] =
        env.FILES_STORAGE === 'local'
          ? [['FILES_DIR', 'the folder that holds uploaded files']]
          : [
              ['FILES_S3_ENDPOINT', "the S3-compatible service's address"],
              ['FILES_S3_REGION', "the bucket's region"],
              ['FILES_S3_BUCKET', 'the bucket that holds uploaded files'],
              ['FILES_S3_ACCESS_KEY_ID', 'the access key for the bucket'],
              ['FILES_S3_SECRET_ACCESS_KEY', "the access key's secret"],
            ];
      needed.push(['FILES_LINK_SECRET', 'the secret that signs file links, 32 characters or more']);
      for (const [variable, what] of needed) {
        if (env[variable] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [variable],
            message: `required for the app and all roles: ${what}`,
          });
        }
      }
    }
    if (env.ROLE === 'app') {
      if (env.SECRETS_PUBLIC_KEY === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['SECRETS_PUBLIC_KEY'],
          message:
            "required for the app role: the vault's public key, as version:public-key; node dist/vault.js new-key prints it",
        });
      }
      if (env.SECRETS_KEYS !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['SECRETS_KEYS'],
          message:
            'not allowed in the app role: only the worker opens secrets, so give the app SECRETS_PUBLIC_KEY alone',
        });
      }
    } else if (env.SECRETS_KEYS === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SECRETS_KEYS'],
        message:
          "required for the worker and all roles: the vault's keys, as version:private-key, the current one first; make one with node dist/vault.js new-key 1",
      });
    }
    // .env.example's secrets are in the repository for anyone to read.
    for (const variable of ['AUTH_SECRET', 'FILES_LINK_SECRET', 'PUBLIC_INTAKE_SECRET'] as const) {
      if (env.NODE_ENV === 'production' && env[variable]?.includes('dev-only') === true) {
        ctx.addIssue({
          code: 'custom',
          path: [variable],
          message: "must be your own secret in production, not .env.example's",
        });
      }
    }
    if (
      env.NODE_ENV === 'production' &&
      env.SECRETS_KEYS?.some(({ key }) => base64url(key) === EXAMPLE_SECRETS_KEY) === true
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SECRETS_KEYS'],
        message: "must be your own keys in production, not .env.example's",
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.ROLE === 'app' &&
      env.SECRETS_PUBLIC_KEY !== undefined &&
      base64url(env.SECRETS_PUBLIC_KEY.publicKey) === EXAMPLE_SECRETS_PUBLIC_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SECRETS_PUBLIC_KEY'],
        message: "must be your own key in production, not .env.example's",
      });
    }
    if (env.NODE_ENV === 'production' && !env.PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_URL'],
        message: 'must be https:// in production, so session cookies are only sent securely',
      });
    }
    if (env.NODE_ENV === 'production' && env.DEV_TENANT_CONTEXT !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_TENANT_CONTEXT'],
        message: 'not allowed in production: it signs every request in as one user',
      });
    }
    if (env.NODE_ENV === 'production' && env.DEV_SIGN_IN_LIMIT === 'off') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_SIGN_IN_LIMIT'],
        message: 'not allowed in production: without the limit, passwords can be guessed freely',
      });
    }
  });

/**
 * Every environment variable the server reads. A test (hosting-guide.test.ts) fails when
 * one of them is missing from docs/HOSTING.md, apps/server/README.md or, where an install
 * sets it, install.env.example.
 */
export const settingNames: readonly string[] = Object.keys(schema.shape);

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(
    /** The variables that need fixing, in the order they're checked. */
    readonly variables: readonly string[],
    lines: readonly string[],
  ) {
    super(`The server's configuration is invalid:\n${lines.map((line) => `  ${line}`).join('\n')}`);
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const variables: string[] = [];
    const lines: string[] = [];
    for (const issue of result.error.issues) {
      const variable = String(issue.path[0] ?? '(environment)');
      if (!variables.includes(variable)) variables.push(variable);
      // The message only: never the value, which may hold a password.
      lines.push(`${variable}: ${issue.message}`);
    }
    throw new ConfigError(variables, lines);
  }
  const values = result.data;
  return {
    ...(values.AI_LOCAL_SERVERS.length === 0 ? {} : { aiLocalServers: values.AI_LOCAL_SERVERS }),
    ...(values.ROLE === 'worker' || values.PUBLIC_INTAKE_SECRET === undefined
      ? {}
      : { publicIntake: { secret: values.PUBLIC_INTAKE_SECRET } }),
    ...(values.PUBLIC_INTAKE_SECRET === undefined
      ? {}
      : { appointmentLinkSecret: values.PUBLIC_INTAKE_SECRET }),
    ...(values.SITES_SHARED_CACHE_SECONDS === undefined || values.SITES_SHARED_CACHE_SECONDS === 0
      ? {}
      : { sitesSharedCacheSeconds: values.SITES_SHARED_CACHE_SECONDS }),
    ...(values.SITES_PAGE_CACHE_PAGES === undefined
      ? {}
      : { sitesPageCachePages: values.SITES_PAGE_CACHE_PAGES }),
    ...(values.SYSTEM_MAILBOX === undefined ? {} : { systemMailbox: values.SYSTEM_MAILBOX }),
    ...(values.GOOGLE_CLIENT_ID === undefined || values.GOOGLE_CLIENT_SECRET === undefined
      ? {}
      : {
          google: { clientId: values.GOOGLE_CLIENT_ID, clientSecret: values.GOOGLE_CLIENT_SECRET },
        }),
    ...(values.CAMPAIGN_AGENCY_DAILY_LIMIT === undefined
      ? {}
      : { campaignAgencyDailyLimit: values.CAMPAIGN_AGENCY_DAILY_LIMIT }),
    ...(values.DEV_SIGN_IN_LIMIT === 'off' ? { signInLimit: false as const } : {}),
    ...(values.MIGRATE_ON_START ? { migrateOnStart: true as const } : {}),
    nodeEnv: values.NODE_ENV,
    role: values.ROLE,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    databaseAppUrl: values.DATABASE_APP_URL,
    databaseWorkerUrl: values.ROLE === 'app' ? undefined : values.DATABASE_WORKER_URL,
    databasePoolSize: values.DATABASE_POOL_SIZE,
    shutdownTimeoutMs: values.SHUTDOWN_TIMEOUT_MS,
    dashboardDir: values.DASHBOARD_DIR,
    devTenantContext: values.DEV_TENANT_CONTEXT,
    publicUrl: values.PUBLIC_URL,
    ...(values.VOICE_WORKER_ORIGIN === undefined
      ? {}
      : { voiceWorkerOrigin: values.VOICE_WORKER_ORIGIN }),
    authentication:
      values.ROLE === 'worker' ||
      values.DATABASE_AUTH_URL === undefined ||
      values.AUTH_SECRET === undefined
        ? undefined
        : { databaseUrl: values.DATABASE_AUTH_URL, secret: values.AUTH_SECRET },
    mail:
      values.ROLE === 'worker' || values.SMTP_URL === undefined || values.MAIL_FROM === undefined
        ? undefined
        : { smtpUrl: values.SMTP_URL, from: values.MAIL_FROM },
    trustProxy: values.TRUST_PROXY,
    files: filesConfig(values),
    vault: vaultKeys(values),
  };
}

/** The role's vault keys, which the schema has checked are there. */
function vaultKeys(values: z.output<typeof schema>): VaultKeys | undefined {
  if (values.ROLE === 'app') {
    const publicKey = values.SECRETS_PUBLIC_KEY;
    return publicKey === undefined ? undefined : { holds: 'public', publicKey };
  }
  const keys = values.SECRETS_KEYS;
  return keys === undefined ? undefined : { holds: 'private', keys };
}

/** The files settings, which the schema has checked are all there for the storage chosen. */
function filesConfig(values: z.output<typeof schema>): FilesConfig | undefined {
  const { FILES_LINK_SECRET: linkSecret, FILES_MAX_BYTES: maxBytes } = values;
  if (linkSecret === undefined) return undefined;
  const quota =
    values.FILES_BUSINESS_QUOTA_BYTES === undefined
      ? {}
      : { businessQuotaBytes: values.FILES_BUSINESS_QUOTA_BYTES };
  if (values.FILES_STORAGE === 'local') {
    return values.FILES_DIR === undefined
      ? undefined
      : {
          storage: { kind: 'local', directory: values.FILES_DIR },
          maxBytes,
          linkSecret,
          ...quota,
        };
  }
  const {
    FILES_S3_ENDPOINT: endpoint,
    FILES_S3_REGION: region,
    FILES_S3_BUCKET: bucket,
    FILES_S3_ACCESS_KEY_ID: accessKeyId,
    FILES_S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = values;
  if (
    endpoint === undefined ||
    region === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return undefined;
  }
  return {
    storage: {
      kind: 's3',
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      pathStyle: values.FILES_S3_PATH_STYLE,
    },
    maxBytes,
    linkSecret,
    ...quota,
  };
}
