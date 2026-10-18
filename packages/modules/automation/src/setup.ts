// What a business has that automation documents refer to (AUTOMATIONS.md section 4), read
// from its own tables under its tenant context, for the validator and the catalog. Only
// what exists is listed, and a channel or AI counts as available only when an automation
// could really use it now.
import {
  automationDocument,
  automationFieldTypes,
  automationTouches,
  formDefinition,
  submissionQuestions,
  type AutomationCustomField,
  type AutomationDocument,
  type AutomationIssue,
  type AutomationNamed,
  type AutomationSetup,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import {
  readPostalAddressLine,
  readSmsSenders,
  readVerificationSettings,
} from '@repo/module-messaging';
import { sql } from 'kysely';
import * as z from 'zod';

import { UNAVAILABLE_STEPS } from './steps.js';
import { TRIGGER_EVENTS } from './triggers.js';
import { readWebhookSecretNames } from './webhook-secrets.js';
import { readWebhookSigningStatus } from './webhook-signing.js';

/**
 * Everyone in the business who can be assigned a task or notified, as membership ids.
 * Tenancy owns memberships, so the server passes its reader in.
 */
export type ReadAutomationUsers = (
  trx: DatabaseTransaction,
  context: TenantContext,
) => Promise<readonly AutomationNamed[]>;

const storedOptions = z.array(
  z.looseObject({ key: z.string(), label: z.string(), archived: z.boolean().optional() }),
);

async function customFields(trx: DatabaseTransaction): Promise<AutomationSetup['fields']> {
  const rows = await trx
    .selectFrom('crm.field_definitions as field')
    .innerJoin('crm.object_types as type', 'type.id', 'field.object_type_id')
    .innerJoin('crm.field_folders as folder', (join) =>
      join
        .onRef('folder.business_id', '=', 'field.business_id')
        .onRef('folder.id', '=', 'field.folder_id'),
    )
    .select((eb) => [
      'type.kind',
      'field.key',
      'field.label',
      'folder.id as folder_id',
      'folder.name as folder_name',
      'field.value_type',
      'field.options',
      eb
        .selectFrom('crm.field_key_aliases as alias')
        .select((inner) => inner.fn.agg<string[]>('array_agg', ['alias.alias_key']).as('keys'))
        .whereRef('alias.field_id', '=', 'field.id')
        .as('aliases'),
    ])
    .where('type.kind', 'in', ['contact', 'deal'])
    .where('field.archived_at', 'is', null)
    .where('field.merged_into_field_id', 'is', null)
    // A text box list and a file upload field are not conditions, triggers or values a
    // step can set, as in GoHighLevel: automations don't see them.
    .where('field.value_type', 'not in', ['text_list', 'file'])
    // Folders in their order, each folder's fields in theirs, as Settings lists them.
    .orderBy('folder.position')
    .orderBy('folder.created_at')
    .orderBy('folder.id')
    .orderBy('field.position')
    .orderBy('field.key')
    .execute();
  const fields = (kind: 'contact' | 'deal'): AutomationCustomField[] =>
    rows
      .filter((row) => row.kind === kind)
      .map((row) => ({
        key: row.key,
        aliases: row.aliases ?? [],
        type: z.enum(automationFieldTypes).parse(row.value_type),
        // An archived choice stays on old records, but nothing new should pick it.
        options: storedOptions
          .parse(row.options)
          .filter((option) => option.archived !== true)
          .map(({ key, label }) => ({ key, label })),
        // What people call it, and where Settings keeps it: a screen lists fields by these.
        label: row.label,
        folder: { id: toPublicId('field_folder', row.folder_id), name: row.folder_name },
      }));
  return { contact: fields('contact'), deal: fields('deal') };
}

/**
 * Holds the live email templates a document's steps send (a step's template, or the one it
 * syncs with) until the publish commits, and names each step whose template is no longer
 * live. The setup the document was validated against is read without locks, so a template
 * deleted or archived since would otherwise go live in a published step. Deleting and
 * archiving hold the template FOR UPDATE, so the two take turns: one that came first is
 * seen here, and one that comes after sees this workflow among the template's uses. Held in
 * id order, as bulk changes hold them.
 */
export async function lockSentTemplates(
  trx: DatabaseTransaction,
  businessId: string,
  document: AutomationDocument,
): Promise<AutomationIssue[]> {
  const sent: { readonly path: string; readonly id: string | undefined }[] = [];
  for (const [key, step] of Object.entries(document.steps)) {
    if (step.type !== 'email.send') continue;
    const config = step.config;
    if ('template' in config)
      sent.push({
        path: `/steps/${key}/config/template`,
        id: parsePublicId('template', config.template),
      });
    else if ('mode' in config && config.mode === 'sync')
      sent.push({
        path: `/steps/${key}/config/source`,
        id: parsePublicId('template', config.source.id),
      });
  }
  const ids = [...new Set(sent.flatMap((each) => each.id ?? []))].sort();
  const live =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('messaging.templates')
          .select('id')
          .where('business_id', '=', businessId)
          .where('id', 'in', ids)
          .where('channel', '=', 'email')
          .where('archived_at', 'is', null)
          .orderBy('id')
          .forShare()
          .execute();
  const held = new Set(live.map((row) => row.id));
  return sent
    .filter((each) => each.id === undefined || !held.has(each.id))
    .map((each) => ({
      path: each.path,
      code: 'template_unavailable',
      message: 'This template was deleted or archived. Choose another template.',
    }));
}

/** What this install can do at all, whatever a business has connected. */
export interface InstallCapabilities {
  readonly teamNotifications?: boolean | undefined;
  /** Whether this install's worker can open secrets, and so sign and send webhooks. */
  readonly webhookDelivery: boolean;
  /**
   * Whether a text message can be handed to its provider: a vault for the credentials and
   * a public https address the provider can report delivery to.
   */
  readonly smsDelivery: boolean;
}

/** Trigger types nothing fires: they listen for no event, and no timer or intake starts them. */
const UNAVAILABLE_TRIGGERS = Object.entries(TRIGGER_EVENTS)
  .filter(([, mapping]) => mapping.events.length === 0)
  .map(([type]) => type);

/** The business's setup, for validating and describing automation documents. */
export async function readAutomationSetup(
  trx: DatabaseTransaction,
  context: TenantContext,
  users: ReadAutomationUsers,
  install: InstallCapabilities,
): Promise<AutomationSetup> {
  const [
    fields,
    forms,
    templates,
    mailboxes,
    numbers,
    calendars,
    pipelines,
    stages,
    lostReasons,
    tags,
    automations,
    people,
    signing,
  ] = await Promise.all([
    customFields(trx),
    // Published forms, and drafts: a draft takes no submission, and a trigger that names one
    // is told to publish it rather than that it does not exist. Archived forms are not listed.
    trx
      .selectFrom('forms.forms')
      .select(['id', 'name', 'status', 'definition', 'published_definition'])
      .where('status', 'in', ['published', 'draft'])
      .orderBy('name')
      .execute(),
    trx
      .selectFrom('messaging.templates')
      .select(['id', 'name'])
      .where('channel', '=', 'email')
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute(),
    trx
      .selectFrom('messaging.mailboxes as mailbox')
      .innerJoin('messaging.channel_accounts as channel', (join) =>
        join
          .onRef('channel.id', '=', 'mailbox.id')
          .onRef('channel.business_id', '=', 'mailbox.business_id'),
      )
      .select(['mailbox.id', 'channel.name'])
      // Only a mailbox an automation may send through: connected and working, and marked
      // for conversations, as email.send requires.
      .where('channel.status', '=', 'active')
      .where('mailbox.use_for_conversations', '=', true)
      .orderBy('channel.name')
      .execute(),
    // Only a number sms.send may send from: messaging's own rule for one that can send now.
    readSmsSenders(trx),
    trx
      .selectFrom('calendar.calendars')
      .select(['id', 'name'])
      .where('is_active', '=', true)
      .orderBy('name')
      .execute(),
    trx
      .selectFrom('crm.pipelines')
      .select(['id', 'name'])
      .where('archived_at', 'is', null)
      .orderBy('position')
      .execute(),
    trx
      .selectFrom('crm.pipeline_stages')
      .select(['id', 'name', 'pipeline_id'])
      .where('archived_at', 'is', null)
      .orderBy('position')
      .execute(),
    trx
      .selectFrom('crm.lost_reasons')
      .select(['id', 'label'])
      .where('archived_at', 'is', null)
      .orderBy('position')
      .execute(),
    // Every tag row is live: merging or deleting a tag removes its row.
    trx.selectFrom('crm.tags').select(['id', 'name']).orderBy('name').execute(),
    trx
      .selectFrom('automation.automations as automation')
      .leftJoin('automation.versions as version', (join) =>
        join
          .onRef('version.id', '=', 'automation.published_version_id')
          .onRef('version.business_id', '=', 'automation.business_id'),
      )
      .select(['automation.id', 'automation.name', 'version.document'])
      // The automations its published version starts, as its steps name them.
      .select(
        sql<string[]>`coalesce((
          select array_agg(distinct step.value -> 'config' ->> 'automation'
                           order by step.value -> 'config' ->> 'automation')
          from jsonb_each(version.document -> 'steps') as step
          where step.value ->> 'type' = 'automation.run'
            and step.value -> 'config' ->> 'automation' is not null), '{}')`.as('starts'),
      )
      // The automations whose runs ending start its published version.
      .select(
        sql<string[]>`coalesce((
          select array_agg(distinct named.value order by named.value)
          from jsonb_array_elements(version.document -> 'triggers') as listed
          cross join lateral jsonb_array_elements_text(listed -> 'config' -> 'automations') as named(value)
          where listed ->> 'type' = 'automation.run_ended'), '{}')`.as('starts_after'),
      )
      .where('automation.status', '<>', 'archived')
      .orderBy('automation.name')
      .execute(),
    users(trx, context),
    readWebhookSigningStatus(trx),
  ]);
  const webhookSecrets = await readWebhookSecretNames(trx);
  const triggerLinks = await trx
    .selectFrom('messaging.trigger_links')
    .select(['id', 'name', 'key'])
    .orderBy('name_normalized')
    .execute();
  const customValues = await trx
    .selectFrom('crm.custom_values')
    .select('key')
    .orderBy('key')
    .execute();
  // What a marketing email's footer shows (messaging: email-compose.ts). Messaging owns the
  // rule for what counts as an address; this asks it.
  const postalAddress = (await readPostalAddressLine(trx, context)) !== null;
  // Whether an Email verification step can check an address (Settings → Email Services).
  const emailVerification = (await readVerificationSettings(trx)).enabled;
  return {
    fields,
    forms: forms.map((form) => {
      // The questions a run reads the answers of (trigger.answers.<key>): what the form
      // has published, or for a draft what it would publish. A definition that no longer
      // reads is left without them: its answers are then text.
      const published = form.status === 'published';
      const definition = formDefinition.safeParse(
        published ? form.published_definition : form.definition,
      );
      return {
        id: toPublicId('form', form.id),
        name: form.name,
        ...(definition.success ? { questions: submissionQuestions(definition.data.fields) } : {}),
        status: published ? ('published' as const) : ('draft' as const),
      };
    }),
    emailTemplates: templates.map((template) => ({
      id: toPublicId('template', template.id),
      name: template.name,
    })),
    // No WhatsApp templates until the WhatsApp channel exists.
    whatsappTemplates: [],
    mailboxes: mailboxes.map((mailbox) => ({
      id: toPublicId('mailbox', mailbox.id),
      name: mailbox.name,
    })),
    // An install that can't deliver a text offers no number, so no step can name one.
    phoneNumbers: install.smsDelivery
      ? numbers.map((number) => ({
          id: toPublicId('phone_number', number.id),
          name: number.name,
        }))
      : [],
    calendars: calendars.map((calendar) => ({
      id: toPublicId('calendar', calendar.id),
      name: calendar.name,
    })),
    pipelines: pipelines.map((pipeline) => ({
      id: toPublicId('pipeline', pipeline.id),
      name: pipeline.name,
      stages: stages
        .filter((stage) => stage.pipeline_id === pipeline.id)
        .map((stage) => ({ id: toPublicId('stage', stage.id), name: stage.name })),
    })),
    lostReasons: lostReasons.map((reason) => ({
      id: toPublicId('lost_reason', reason.id),
      name: reason.label,
    })),
    tags: tags.map((tag) => ({ id: toPublicId('tag', tag.id), name: tag.name })),
    users: people,
    // Each with what its published version starts, so a start that would loop is refused.
    // A published document names automations by id; anything else names none of these.
    automations: automations.map((automation) => ({
      id: toPublicId('automation', automation.id),
      name: automation.name,
      starts: automation.starts.filter(
        (reference) => parsePublicId('automation', reference) !== undefined,
      ),
      startsAfter: automation.starts_after.filter(
        (reference) => parsePublicId('automation', reference) !== undefined,
      ),
      // What it listens for on a contact and what it changes there, so a change one
      // workflow makes that starts another is told.
      ...touchesOf(automation.document),
    })),
    // What the "Trigger link clicked" trigger names, and a step's text writes by key.
    triggerLinks: triggerLinks.map((link) => ({
      id: toPublicId('trigger_link', link.id),
      name: link.name,
      key: link.key,
    })),
    // The business's custom values, by key: a step's text may write one as
    // {{custom_values.<key>}} or {{values.<key>}}. One with no text yet is still listed,
    // as a field no contact has a value for is: the step that uses it stops when it runs.
    values: customValues.map((value) => value.key),
    postalAddress,
    // A channel is available when an automation can really send on it: email through a
    // mailbox email.send may use, and text messages from a number that can send, on an
    // install that can deliver them. There is no WhatsApp channel yet.
    channels: {
      email: mailboxes.length > 0,
      sms: install.smsDelivery && numbers.length > 0,
      whatsapp: false,
    },
    // A webhook step can run only with a signing secret and a worker able to open it.
    webhooks: signing.configured && install.webhookDelivery,
    // The secrets a webhook step's header may send, by name.
    webhookSecrets,
    emailVerification,
    // AI steps don't run in automations yet.
    ai: false,
    // What the catalog lists but nothing here runs or fires yet: refused when validated.
    unavailableSteps: [
      ...Object.keys(UNAVAILABLE_STEPS),
      ...(install.teamNotifications === true ? [] : ['team.notify']),
    ],
    unavailableTriggers: UNAVAILABLE_TRIGGERS,
  };
}

/** A published document's listens and writes; nothing for one that is missing or no longer reads. */
function touchesOf(document: unknown): { listens?: string[]; writes?: string[] } {
  if (document === null || document === undefined) return {};
  const parsed = automationDocument.safeParse(document);
  if (!parsed.success) return {};
  const { listens, writes } = automationTouches(parsed.data);
  return { listens: [...listens], writes: [...writes] };
}
