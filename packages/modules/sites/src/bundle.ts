// Sharing a site: export one as a signed bundle, import a bundle as a new site in another
// business of the same agency. A bundle carries the steps, each control page's newest
// version and the saved sections they use; never the domain, the chat widget, the tracking
// codes, statistics or history, which belong to the business it came from.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  exportSite,
  importSiteInput,
  SITE_TEMPLATE_LIMITS,
  siteBundlePayload,
  type Site,
  type SiteBundle,
  type SiteBundlePayload,
} from '@repo/contracts';
import { ConflictError, toPublicId } from '@repo/kernel';

import { openBundle, signBundle } from './bundle-signature.js';
import { addSteps, readSiteContent } from './copies.js';
import { kindOf, requireSite } from './rows.js';
import { heldFolder, readSite, requireRoomForSite } from './sites.js';
import { invalid, madeBy } from './support.js';

export interface BundleCommands {
  readonly export: Command<typeof exportSite.params, SiteBundle>;
  readonly import: Command<typeof importSiteInput, Site>;
}

/** The two commands, given the install's secret that signs and checks bundles. */
export function createBundleCommands(
  secret: string,
  now: () => Date = () => new Date(),
): BundleCommands {
  const exportCommand = defineCommand({
    name: 'site.export',
    permission: 'sites.share',
    input: exportSite.params,
    async handle(trx, input, command): Promise<SiteBundle> {
      requireBusiness(command.context);
      const site = await requireSite(trx, input.id);
      const content = await readSiteContent(
        trx,
        { id: site.id, kind: kindOf(site.kind) },
        { universal: true },
      );
      const payload: SiteBundlePayload = {
        type: 'crm.site-bundle',
        version: 1,
        agency: command.context.agencyId,
        exportedAt: now().toISOString(),
        name: site.name,
        content,
      };
      const bundle = signBundle(secret, payload);
      if (bundle.length > SITE_TEMPLATE_LIMITS.bundle)
        throw new ConflictError(
          'This site is too large to share as one bundle. Share it in parts, as templates.',
        );
      await command.emit({
        type: 'site.exported',
        subject: { kind: 'site', id: site.id },
        payload: { steps: content.steps.length },
      });
      return { bundle };
    },
  });

  const importCommand = defineCommand({
    name: 'site.import',
    permission: 'sites.manage',
    input: importSiteInput,
    // The audit log keeps that a bundle was imported and how large, not the bundle.
    audit: ({ bundle, ...rest }) => ({ ...rest, bundleLength: bundle.length }),
    async handle(trx, input, command): Promise<Site> {
      const businessId = requireBusiness(command.context);
      const opened = siteBundlePayload.safeParse(openBundle(secret, input.bundle));
      if (!opened.success)
        throw invalid(
          '/bundle',
          'invalid_bundle',
          'This is not a bundle this install made, or it was changed on the way.',
        );
      const payload = opened.data;
      if (payload.agency !== command.context.agencyId)
        throw invalid('/bundle', 'foreign_bundle', 'This bundle comes from another agency.');
      const { content } = payload;
      if (content.kind !== 'funnel' && content.kind !== 'website')
        throw invalid('/bundle', 'invalid_bundle', 'This bundle holds no funnel or website.');
      await requireRoomForSite(trx, businessId);
      const folderId = await heldFolder(trx, input.folderId, content.kind);
      const row = await trx
        .insertInto('sites.sites')
        .values({
          business_id: businessId,
          kind: content.kind,
          name: input.name ?? payload.name,
          folder_id: folderId,
          ...madeBy(command),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await addSteps(trx, command, { businessId, id: row.id, kind: content.kind }, content);
      await command.emit({
        type: 'site.imported',
        subject: { kind: 'site', id: row.id },
        payload: { name: input.name ?? payload.name, kind: content.kind },
      });
      return readSite(trx, command, toPublicId('site', row.id));
    },
  });

  return { export: exportCommand, import: importCommand };
}
