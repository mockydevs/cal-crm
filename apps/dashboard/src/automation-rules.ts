// What the builder offers, and to whom: which steps this business can use yet, what the
// person may do, and the business's setup in the shape the contract's validator reads.
import {
  automationFieldTypes,
  type AutomationCustomField,
  type AutomationFieldType,
  type AutomationSetup,
} from '@repo/contracts';
import { isRecord } from './automation-document';

export {
  availableTriggers,
  missingSetupOf,
  stepPicker,
  type MissingSetup,
  type SetupState,
  type StepPicker,
} from './automation-availability';

export interface AutomationAccess {
  /** May create automations and change drafts (automations.manage). */
  readonly canManage: boolean;
  /** May publish, pause and resume (automations.publish). */
  readonly canPublish: boolean;
}

/**
 * What the person may do, as the API says with what it returns. Anything but a plain
 * "true" is a no: without the permission the builder is read-only, and the publishing
 * controls aren't offered.
 */
export function automationAccess(answer: unknown): AutomationAccess {
  const flags = isRecord(answer) ? answer : {};
  return { canManage: flags['canManage'] === true, canPublish: flags['canPublish'] === true };
}

const fieldTypes: readonly string[] = automationFieldTypes;
const isFieldType = (type: string): type is AutomationFieldType => fieldTypes.includes(type);

interface CatalogField {
  readonly key: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  // An install from before fields were named here answers neither.
  readonly label?: string | undefined;
  readonly folder?: { readonly id: string; readonly name: string } | null | undefined;
}

/**
 * The catalog's setup as the validator takes it. The API sends each field's type as text;
 * a type this version doesn't know is read as text, the loosest, so the as-you-type check
 * doesn't invent a problem the server wouldn't report.
 */
export function setupOf(
  setup: Omit<AutomationSetup, 'fields' | 'triggerLinks'> & {
    readonly fields: {
      readonly contact: readonly CatalogField[];
      readonly deal: readonly CatalogField[];
    };
    // An install from before trigger links answers none.
    readonly triggerLinks?: AutomationSetup['triggerLinks'] | undefined;
  },
): AutomationSetup {
  const known = (fields: readonly CatalogField[]): AutomationCustomField[] =>
    fields.map((field) => ({
      key: field.key,
      aliases: field.aliases,
      type: isFieldType(field.type) ? field.type : 'text',
      options: field.options.map((option) => ({ key: option.key, label: option.label })),
      ...(field.label === undefined ? {} : { label: field.label }),
      ...(field.folder === undefined || field.folder === null
        ? {}
        : { folder: { id: field.folder.id, name: field.folder.name } }),
    }));
  return {
    forms: setup.forms,
    emailTemplates: setup.emailTemplates,
    whatsappTemplates: setup.whatsappTemplates,
    mailboxes: setup.mailboxes,
    phoneNumbers: setup.phoneNumbers,
    calendars: setup.calendars,
    pipelines: setup.pipelines,
    lostReasons: setup.lostReasons,
    tags: setup.tags,
    users: setup.users,
    automations: setup.automations,
    values: setup.values,
    channels: setup.channels,
    ai: setup.ai,
    webhooks: setup.webhooks,
    ...(setup.emailVerification === undefined
      ? {}
      : { emailVerification: setup.emailVerification }),
    unavailableSteps: setup.unavailableSteps,
    unavailableTriggers: setup.unavailableTriggers,
    ...(setup.triggerLinks === undefined ? {} : { triggerLinks: setup.triggerLinks }),
    fields: { contact: known(setup.fields.contact), deal: known(setup.fields.deal) },
  };
}
