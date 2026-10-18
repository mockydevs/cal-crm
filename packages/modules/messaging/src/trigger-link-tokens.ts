// A trigger link in a message, and its click. When a message for a contact writes
// {{trigger_link.<key>}}, the field becomes an address of this install holding one random
// token; only the token's digest is stored, with the link and the contact it was issued
// for. Opening the address finds the tenant from the digest alone, records the click as
// that contact, tells automations, and answers with the link's stored destination: the
// request chooses nothing about where it is sent.
import { createHash, randomBytes } from 'node:crypto';
import { allowEveryone, defineCommand, requireBusiness, runCommand } from '@repo/commands';
import {
  mergeTokens,
  renderMessageTemplate,
  TRIGGER_LINK_PATH,
  triggerLinkKeys,
  triggerLinkMergeKey,
  triggerLinkToken,
  type ConditionValues,
  type RenderableTemplate,
  type RenderedTemplate,
} from '@repo/contracts';
import type { Database, DatabaseTransaction } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

const digestOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * How long after a recorded click another click on the same address is not recorded again:
 * a double click, or a mail scanner opening the link just before the person does. The
 * browser is sent on either way.
 */
export const TRIGGER_LINK_REPEAT_SECONDS = 60;

/** Where token addresses start, or nothing when the install has no usable public address. */
function addressBase(publicUrl: string | undefined): URL | undefined {
  if (publicUrl === undefined) return undefined;
  try {
    const base = new URL(publicUrl);
    const web = base.protocol === 'https:' || base.protocol === 'http:';
    return web && base.username === '' && base.password === '' ? base : undefined;
  } catch {
    return undefined;
  }
}

async function linksByKey(
  trx: DatabaseTransaction,
  keys: readonly string[],
): Promise<readonly { readonly id: string; readonly key: string }[]> {
  if (keys.length === 0) return [];
  return trx
    .selectFrom('messaging.trigger_links')
    .select(['id', 'key'])
    .where('key', 'in', [...keys])
    .orderBy('key')
    .execute();
}

/**
 * This contact's own address for each of these links, by merge field. A key no link has,
 * and every key on an install without a public address, is left out, so a send that uses
 * it stops as for any field without a value. Each call issues new tokens.
 */
export async function issueTriggerLinkAddresses(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: {
    readonly contactId: string;
    readonly keys: readonly string[];
    readonly publicUrl: string | undefined;
  },
): Promise<Record<string, string>> {
  const businessId = requireBusiness(context);
  const base = addressBase(input.publicUrl);
  if (base === undefined) return {};
  const addresses: Record<string, string> = {};
  for (const link of await linksByKey(trx, input.keys)) {
    // Node's crypto.randomBytes is a CSPRNG: 256 bits nobody can guess or enumerate.
    const token = randomBytes(32).toString('base64url');
    await trx
      .insertInto('messaging.trigger_link_tokens')
      .values({
        business_id: businessId,
        link_id: link.id,
        contact_id: input.contactId,
        digest: digestOf(token),
      })
      .execute();
    addresses[triggerLinkMergeKey(link.key)] = new URL(
      `${TRIGGER_LINK_PATH}/${token}`,
      base,
    ).toString();
  }
  return addresses;
}

/**
 * Text filled in for one contact, trigger links included. Tokens are issued only for text
 * that then fills in completely: a send that stops for another missing value leaves none.
 */
export async function renderWithTriggerLinks(
  trx: DatabaseTransaction,
  context: TenantContext,
  input: {
    readonly contactId: string;
    readonly text: RenderableTemplate;
    readonly values: ConditionValues;
    readonly publicUrl: string | undefined;
  },
): Promise<RenderedTemplate> {
  const keys = triggerLinkKeys(mergeTokens(input.text));
  if (keys.length === 0) return renderMessageTemplate(input.text, input.values);
  const known = addressBase(input.publicUrl) === undefined ? [] : await linksByKey(trx, keys);
  const probe = renderMessageTemplate(input.text, {
    ...input.values,
    ...Object.fromEntries(known.map((link) => [triggerLinkMergeKey(link.key), 'address'])),
  });
  if (!probe.ok) return probe;
  return renderMessageTemplate(input.text, {
    ...input.values,
    ...(await issueTriggerLinkAddresses(trx, context, {
      contactId: input.contactId,
      keys,
      publicUrl: input.publicUrl,
    })),
  });
}

const click = defineCommand({
  name: 'trigger_link.click',
  permission: 'contacts.manage',
  input: z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/) }),
  // The digest is the capability's; the log names the link from the event instead.
  audit: () => ({ source: 'trigger_link' }),
  async handle(trx, { digest }, command): Promise<string | undefined> {
    requireBusiness(command.context);
    // Read again under row-level security: the scope function only said where to look.
    const token = await trx
      .selectFrom('messaging.trigger_link_tokens as t')
      .innerJoin('messaging.trigger_links as l', (join) =>
        join.onRef('l.business_id', '=', 't.business_id').onRef('l.id', '=', 't.link_id'),
      )
      .select(['t.id', 't.link_id', 't.contact_id', 'l.key', 'l.name', 'l.url'])
      .where('t.digest', '=', digest)
      .executeTakeFirst();
    if (token === undefined) return undefined;
    // Clicks on one address take turns, so two at once can't both count as the first.
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${`messaging.trigger_link_token:${token.id}`}, 0))
    `.execute(trx);
    const recent = await trx
      .selectFrom('messaging.trigger_link_clicks')
      .select('id')
      .where('token_id', '=', token.id)
      .where(
        'clicked_at',
        '>',
        sql<Date>`now() - make_interval(secs => ${TRIGGER_LINK_REPEAT_SECONDS})`,
      )
      .limit(1)
      .executeTakeFirst();
    if (recent === undefined) {
      await trx
        .insertInto('messaging.trigger_link_clicks')
        .values({
          business_id: requireBusiness(command.context),
          link_id: token.link_id,
          contact_id: token.contact_id,
          token_id: token.id,
        })
        .execute();
      // On the contact's timeline, and what the "Trigger link clicked" trigger listens for.
      await command.emit({
        type: 'trigger_link.clicked',
        subject: { kind: 'trigger_link', id: token.link_id },
        records: [token.contact_id],
        payload: {
          linkId: toPublicId('trigger_link', token.link_id),
          key: token.key,
          name: token.name,
        },
      });
    }
    return token.url;
  },
});

/** Only a web address is ever answered with, whatever a row holds. */
function webAddress(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records the click a token stands for and gives where to send the browser, or nothing
 * for a token that was never issued or whose link is gone. The capability alone decides
 * the scope; session headers and tenant ids are never used.
 */
export async function openTriggerLink(
  db: Database,
  token: string,
  correlationId: string,
): Promise<string | undefined> {
  if (!triggerLinkToken.safeParse(token).success) return undefined;
  const digest = digestOf(token);
  const {
    rows: [scope],
  } = await sql<{ agency_id: string; business_id: string; contact_id: string }>`
    select agency_id, business_id, contact_id from private.trigger_link_scope(${digest})
  `.execute(db);
  if (scope === undefined) return undefined;
  // The unexported command is entered only after the capability located its tenant, and
  // reads the capability again there. It grants no signed-in user's powers.
  const url = await runCommand(
    { db, authorize: allowEveryone },
    click,
    { digest },
    {
      context: {
        agencyId: scope.agency_id,
        businessId: scope.business_id,
        actorKind: 'contact',
        actorId: scope.contact_id,
        correlationId: z.uuid().parse(correlationId),
      },
      permissions: 'all',
    },
  );
  return url === undefined ? undefined : webAddress(url);
}
