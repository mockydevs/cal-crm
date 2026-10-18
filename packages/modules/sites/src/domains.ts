// Domains a business connects for its sites, and the redirects on them. This phase records
// a domain and what a check of its DNS record found; certificates and serving are the
// publishing phase's, which reads `verification_status` to decide what it serves.
import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  createSiteDomainInput,
  createSiteRedirectInput,
  deleteSiteDomain,
  deleteSiteRedirect,
  SITE_DOMAIN_LIMITS,
  updateSiteDomain,
  updateSiteDomainInput,
  updateSiteRedirect,
  updateSiteRedirectInput,
  type SiteDomain,
  type SiteDomainList,
  type SiteRedirect,
  type SiteRedirectList,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { judgeResolution, recordFor, type SitesTarget } from './dns.js';
import { kindOf } from './rows.js';
import { invalid, madeBy, may, requireRevision, serializeAdditions, uuidOf } from './support.js';

const uniqueErrors = explainUniqueViolation({
  domains_hostname_unique: () =>
    invalid(
      '/hostname',
      'taken',
      'This domain is already connected, here or in another business of this install.',
    ),
  redirects_path_unique: () =>
    invalid('/path', 'taken', 'This domain already has a redirect at this path.'),
});

const statusOf = (status: string): SiteDomain['verification']['status'] =>
  status === 'verified' || status === 'failed' ? status : 'pending';
const certificateOf = (status: string): SiteDomain['certificateStatus'] =>
  status === 'pending' || status === 'issued' || status === 'failed' ? status : 'none';
const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

function domains(trx: DatabaseTransaction) {
  return trx.selectFrom('sites.domains as d').select([
    'd.id',
    'd.hostname',
    'd.verification_status',
    'd.verification_error',
    'd.checked_at',
    'd.verified_at',
    'd.certificate_status',
    'd.www_redirect',
    'd.default_step_id',
    'd.not_found_step_id',
    'd.revision',
    'd.created_at',
    'd.updated_at',
    sql<string>`(select count(*) from sites.sites s
                 where s.business_id = d.business_id and s.domain_id = d.id)::text`.as(
      'site_count',
    ),
  ]);
}

interface DomainRow {
  readonly id: string;
  readonly hostname: string;
  readonly verification_status: string;
  readonly verification_error: string | null;
  readonly checked_at: Date | null;
  readonly verified_at: Date | null;
  readonly certificate_status: string;
  readonly www_redirect: boolean;
  readonly default_step_id: string | null;
  readonly not_found_step_id: string | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly site_count: string;
}

const stepOf = (id: string | null): string | null =>
  id === null ? null : toPublicId('site_step', id);

const recordOf = (hostname: string, target: SitesTarget | undefined): SiteDomain['record'] => {
  const record = target === undefined ? undefined : recordFor(hostname, target);
  return record === undefined ? null : { ...record };
};

const asDomain = (row: DomainRow, target: SitesTarget | undefined): SiteDomain => ({
  id: toPublicId('site_domain', row.id),
  hostname: row.hostname,
  record: recordOf(row.hostname, target),
  verification: {
    status: statusOf(row.verification_status),
    error: row.verification_error,
    checkedAt: iso(row.checked_at),
    verifiedAt: iso(row.verified_at),
  },
  certificateStatus: certificateOf(row.certificate_status),
  wwwRedirect: row.www_redirect,
  defaultStepId: stepOf(row.default_step_id),
  notFoundStepId: stepOf(row.not_found_step_id),
  siteCount: Number(row.site_count),
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

async function requireDomain(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<DomainRow> {
  let query = domains(trx).where('d.id', '=', uuidOf('site_domain', publicId));
  if (lock) query = query.forUpdate('d');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Domain', publicId);
  return row;
}

/** A step of this business a domain may open at; another business's is refused. */
async function heldStep(
  trx: DatabaseTransaction,
  publicId: string | null,
  field: string,
): Promise<string | null> {
  if (publicId === null) return null;
  const step = await trx
    .selectFrom('sites.steps')
    .select('id')
    .where('id', '=', uuidOf('site_step', publicId))
    .forShare()
    .executeTakeFirst();
  if (step === undefined)
    throw invalid(`/${field}`, 'invalid_step', 'Choose a step of a site of this business.');
  return step.id;
}

/** What the server found when it looked a host name up: handed to the command as its input. */
export const domainCheckInput = z.strictObject({
  id: z.string(),
  cnames: z.array(z.string().max(300)).max(20),
  addresses: z.array(z.string().max(64)).max(40),
});

const updateInput = updateSiteDomainInput.extend(updateSiteDomain.params.shape);

export interface DomainCommands {
  readonly read: (
    trx: DatabaseTransaction,
    invocation: Invocation,
    publicId: string,
  ) => Promise<SiteDomain>;
  readonly list: (trx: DatabaseTransaction, invocation: Invocation) => Promise<SiteDomainList>;
  readonly create: Command<typeof createSiteDomainInput, SiteDomain>;
  readonly update: Command<typeof updateInput, SiteDomain>;
  readonly check: Command<typeof domainCheckInput, SiteDomain>;
  readonly remove: Command<typeof deleteSiteDomain.params, undefined>;
}

/** The domain readers and commands, given where this install's sites answer. */
export function createDomainCommands(target: SitesTarget | undefined): DomainCommands {
  const read = async (
    trx: DatabaseTransaction,
    invocation: Invocation,
    publicId: string,
  ): Promise<SiteDomain> => {
    requireBusiness(invocation.context);
    return asDomain(await requireDomain(trx, publicId), target);
  };

  const list = async (
    trx: DatabaseTransaction,
    invocation: Invocation,
  ): Promise<SiteDomainList> => {
    requireBusiness(invocation.context);
    const rows = await domains(trx).orderBy('d.hostname').execute();
    return {
      items: rows.map((row) => asDomain(row, target)),
      canManage: may(invocation, 'domains.manage'),
    };
  };

  const create = defineCommand({
    name: 'site_domain.create',
    permission: 'domains.manage',
    input: createSiteDomainInput,
    async handle(trx, input, command): Promise<SiteDomain> {
      const businessId = requireBusiness(command.context);
      await serializeAdditions(trx, businessId, 'domains');
      const { count } = await trx
        .selectFrom('sites.domains')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      if (Number(count) >= SITE_DOMAIN_LIMITS.domains)
        throw invalid(
          '/hostname',
          'limit_reached',
          `A business can connect at most ${String(SITE_DOMAIN_LIMITS.domains)} domains.`,
        );
      const row = await trx
        .insertInto('sites.domains')
        .values({ business_id: businessId, hostname: input.hostname, ...madeBy(command) })
        .returning('id')
        .executeTakeFirstOrThrow()
        .catch(uniqueErrors);
      await command.emit({
        type: 'site_domain.connected',
        subject: { kind: 'site_domain', id: row.id },
        payload: { hostname: input.hostname },
      });
      return read(trx, command, toPublicId('site_domain', row.id));
    },
  });

  const update = defineCommand({
    name: 'site_domain.update',
    permission: 'domains.manage',
    input: updateInput,
    async handle(trx, input, command): Promise<SiteDomain> {
      requireBusiness(command.context);
      const current = await requireDomain(trx, input.id, true);
      requireRevision(current.revision, input.revision, 'domain');
      const defaultStep =
        input.defaultStepId === undefined
          ? undefined
          : await heldStep(trx, input.defaultStepId, 'defaultStepId');
      const notFoundStep =
        input.notFoundStepId === undefined
          ? undefined
          : await heldStep(trx, input.notFoundStepId, 'notFoundStepId');
      await trx
        .updateTable('sites.domains')
        .set({
          revision: current.revision + 1,
          ...(input.wwwRedirect === undefined ? {} : { www_redirect: input.wwwRedirect }),
          ...(defaultStep === undefined ? {} : { default_step_id: defaultStep }),
          ...(notFoundStep === undefined ? {} : { not_found_step_id: notFoundStep }),
        })
        .where('id', '=', current.id)
        .execute();
      await command.emit({
        type: 'site_domain.updated',
        subject: { kind: 'site_domain', id: current.id },
        payload: { hostname: current.hostname },
      });
      return read(trx, command, input.id);
    },
  });

  /** Records what a lookup found. The lookup is made before this, outside any transaction. */
  const check = defineCommand({
    name: 'site_domain.verify',
    permission: 'domains.manage',
    input: domainCheckInput,
    async handle(trx, input, command): Promise<SiteDomain> {
      requireBusiness(command.context);
      if (target === undefined)
        throw new ConflictError(
          'This install has not been told where its sites answer, so a domain cannot be checked yet.',
        );
      const current = await requireDomain(trx, input.id, true);
      const verdict = judgeResolution(current.hostname, target, input);
      await trx
        .updateTable('sites.domains')
        .set(
          verdict.verified
            ? {
                verification_status: 'verified',
                verification_error: null,
                // The first time it was seen pointing here: later checks keep it.
                verified_at: sql<Date>`coalesce(verified_at, now())`,
                checked_at: sql<Date>`now()`,
                revision: current.revision + 1,
              }
            : {
                verification_status: 'failed',
                verification_error: verdict.error,
                verified_at: null,
                checked_at: sql<Date>`now()`,
                revision: current.revision + 1,
              },
        )
        .where('id', '=', current.id)
        .execute();
      await command.emit({
        type: verdict.verified ? 'site_domain.verified' : 'site_domain.check_failed',
        subject: { kind: 'site_domain', id: current.id },
        payload: { hostname: current.hostname },
      });
      return read(trx, command, input.id);
    },
  });

  const remove = defineCommand({
    name: 'site_domain.delete',
    permission: 'domains.manage',
    input: deleteSiteDomain.params,
    async handle(trx, input, command): Promise<undefined> {
      requireBusiness(command.context);
      const current = await requireDomain(trx, input.id, true);
      // The table takes its redirects, and leaves its sites without a domain.
      await trx.deleteFrom('sites.domains').where('id', '=', current.id).execute();
      await command.emit({
        type: 'site_domain.disconnected',
        subject: { kind: 'site_domain', id: current.id },
        payload: { hostname: current.hostname },
      });
    },
  });

  return { read, list, create, update, check, remove };
}

// Redirects -----------------------------------------------------------------------------------

function redirects(trx: DatabaseTransaction) {
  return trx
    .selectFrom('sites.redirects as r')
    .innerJoin('sites.domains as d', (join) =>
      join.onRef('d.business_id', '=', 'r.business_id').onRef('d.id', '=', 'r.domain_id'),
    )
    .leftJoin('sites.sites as s', (join) =>
      join.onRef('s.business_id', '=', 'r.business_id').onRef('s.id', '=', 'r.target_site_id'),
    )
    .select([
      'r.id',
      'r.domain_id',
      'd.hostname',
      'r.path',
      'r.target_site_id',
      'r.target_url',
      'r.status',
      'r.revision',
      'r.created_at',
      'r.updated_at',
      's.name as site_name',
      's.kind as site_kind',
    ]);
}

interface RedirectRow {
  readonly id: string;
  readonly domain_id: string;
  readonly hostname: string;
  readonly path: string;
  readonly target_site_id: string | null;
  readonly target_url: string | null;
  readonly status: number;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly site_name: string | null;
  readonly site_kind: string | null;
}

const asRedirect = (row: RedirectRow): SiteRedirect => ({
  id: toPublicId('site_redirect', row.id),
  domainId: toPublicId('site_domain', row.domain_id),
  hostname: row.hostname,
  path: row.path,
  target:
    row.target_site_id === null
      ? { type: 'url', url: row.target_url ?? '' }
      : {
          type: 'site',
          siteId: toPublicId('site', row.target_site_id),
          siteName: row.site_name ?? '',
          siteKind: kindOf(row.site_kind ?? 'funnel'),
        },
  status: row.status === 302 ? 302 : 301,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

async function requireRedirect(
  trx: DatabaseTransaction,
  publicId: string,
  lock = false,
): Promise<RedirectRow> {
  let query = redirects(trx).where('r.id', '=', uuidOf('site_redirect', publicId));
  if (lock) query = query.forUpdate('r');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Redirect', publicId);
  return row;
}

/** The business's redirects, by domain and path. */
export async function readSiteRedirects(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<SiteRedirectList> {
  requireBusiness(invocation.context);
  const rows = await redirects(trx).orderBy('d.hostname').orderBy('r.path').execute();
  return { items: rows.map(asRedirect), canManage: may(invocation, 'domains.manage') };
}

type Target = z.output<typeof createSiteRedirectInput>['target'];

/** Where a redirect goes, as its columns hold it; a site of another business is refused. */
async function heldTarget(
  trx: DatabaseTransaction,
  target: Target,
): Promise<{ target_site_id: string | null; target_url: string | null }> {
  if (target.type === 'url') return { target_site_id: null, target_url: target.url };
  const site = await trx
    .selectFrom('sites.sites')
    .select('id')
    .where('id', '=', uuidOf('site', target.siteId))
    .forShare()
    .executeTakeFirst();
  if (site === undefined)
    throw invalid('/target/siteId', 'invalid_site', 'Choose a funnel or website of this business.');
  return { target_site_id: site.id, target_url: null };
}

export const createSiteRedirectCommand = defineCommand({
  name: 'site_redirect.create',
  permission: 'domains.manage',
  input: createSiteRedirectInput,
  async handle(trx, input, command): Promise<SiteRedirect> {
    const businessId = requireBusiness(command.context);
    await serializeAdditions(trx, businessId, 'redirects');
    const { count } = await trx
      .selectFrom('sites.redirects')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= SITE_DOMAIN_LIMITS.redirects)
      throw invalid(
        '/path',
        'limit_reached',
        `A business can have at most ${String(SITE_DOMAIN_LIMITS.redirects)} redirects.`,
      );
    const domain = await trx
      .selectFrom('sites.domains')
      .select('id')
      .where('id', '=', uuidOf('site_domain', input.domainId))
      .forShare()
      .executeTakeFirst();
    if (domain === undefined)
      throw invalid('/domainId', 'invalid_domain', 'Choose a domain of this business.');
    const row = await trx
      .insertInto('sites.redirects')
      .values({
        business_id: businessId,
        domain_id: domain.id,
        path: input.path,
        status: input.status,
        ...(await heldTarget(trx, input.target)),
        ...madeBy(command),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'site_redirect.created',
      subject: { kind: 'site_redirect', id: row.id },
      payload: { path: input.path, target: input.target.type },
    });
    return asRedirect(await requireRedirect(trx, toPublicId('site_redirect', row.id)));
  },
});

export const updateSiteRedirectCommand = defineCommand({
  name: 'site_redirect.update',
  permission: 'domains.manage',
  input: updateSiteRedirectInput.extend(updateSiteRedirect.params.shape),
  async handle(trx, input, command): Promise<SiteRedirect> {
    requireBusiness(command.context);
    const current = await requireRedirect(trx, input.id, true);
    requireRevision(current.revision, input.revision, 'redirect');
    await trx
      .updateTable('sites.redirects')
      .set({
        path: input.path,
        status: input.status,
        revision: current.revision + 1,
        ...(await heldTarget(trx, input.target)),
      })
      .where('id', '=', current.id)
      .execute()
      .catch(uniqueErrors);
    await command.emit({
      type: 'site_redirect.updated',
      subject: { kind: 'site_redirect', id: current.id },
      payload: { path: input.path, target: input.target.type },
    });
    return asRedirect(await requireRedirect(trx, input.id));
  },
});

export const deleteSiteRedirectCommand = defineCommand({
  name: 'site_redirect.delete',
  permission: 'domains.manage',
  input: deleteSiteRedirect.params,
  async handle(trx, input, command): Promise<void> {
    requireBusiness(command.context);
    const current = await requireRedirect(trx, input.id, true);
    await trx.deleteFrom('sites.redirects').where('id', '=', current.id).execute();
    await command.emit({
      type: 'site_redirect.deleted',
      subject: { kind: 'site_redirect', id: current.id },
      payload: { path: current.path },
    });
  },
});
