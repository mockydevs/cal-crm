// Copying an email template into an action (POST /automations/{id}/draft/email-template-copy):
// the template is read for its revision, then copied with the draft version the edit
// started from. Its own chunk, fetched when a template is first copied, so the builder
// doesn't carry the message-template contract for everyone who opens a workflow.
import {
  copyWorkflowEmailTemplate,
  enableWorkflowEmailSync,
  getMessageTemplate,
  saveSyncedWorkflowEmail,
  type AutomationDraftSaved,
  type EmailContent,
  type MessageTemplate,
  type SyncedWorkflowEmailSaved,
} from '@repo/contracts';
import type { apiIn } from './api';

export async function copyEmailTemplate(
  client: ReturnType<typeof apiIn>,
  input: {
    readonly automationId: string;
    readonly baseDraftVersion: number;
    readonly step: string;
    readonly template: string;
    /** The draft with the edits not saved yet. */
    readonly document: Readonly<Record<string, unknown>>;
  },
): Promise<AutomationDraftSaved> {
  const source = await client.request(getMessageTemplate, { params: { id: input.template } });
  return client.request(copyWorkflowEmailTemplate, {
    params: { id: input.automationId },
    body: {
      baseDraftVersion: input.baseDraftVersion,
      step: input.step,
      template: source.id,
      revision: source.revision,
      document: { ...input.document },
    },
  });
}

/**
 * Making an action sync with a template (POST /automations/{id}/draft/email-sync): the
 * template is read for its revision, then linked with the draft version the edit started
 * from. The action keeps who it is from and its own subject; its own content is dropped,
 * and the template is not changed.
 */
export async function syncEmailTemplate(
  client: ReturnType<typeof apiIn>,
  input: {
    readonly automationId: string;
    readonly baseDraftVersion: number;
    readonly step: string;
    readonly template: string;
    readonly document: Readonly<Record<string, unknown>>;
  },
): Promise<AutomationDraftSaved> {
  const source = await client.request(getMessageTemplate, { params: { id: input.template } });
  return client.request(enableWorkflowEmailSync, {
    params: { id: input.automationId },
    body: {
      baseDraftVersion: input.baseDraftVersion,
      step: input.step,
      template: source.id,
      revision: source.revision,
      document: { ...input.document },
    },
  });
}

/** What an edit made through a syncing action writes: the template's own content. */
export interface SyncedEmailEdit {
  /** The template's revision as the editor read it. */
  readonly revision: string;
  readonly subject: string;
  readonly content: EmailContent;
  readonly preheader: string | null;
}

/**
 * Saving the template a syncing action sends, with the draft, in one go
 * (PUT /automations/{id}/draft/email-sync/content): both are saved or neither is.
 */
export function saveSyncedEmail(
  client: ReturnType<typeof apiIn>,
  input: SyncedEmailEdit & {
    readonly automationId: string;
    readonly baseDraftVersion: number;
    readonly step: string;
    readonly document: Readonly<Record<string, unknown>>;
  },
): Promise<SyncedWorkflowEmailSaved> {
  return client.request(saveSyncedWorkflowEmail, {
    params: { id: input.automationId },
    body: {
      baseDraftVersion: input.baseDraftVersion,
      step: input.step,
      revision: input.revision,
      subject: input.subject,
      content: input.content,
      preheader: input.preheader,
      document: { ...input.document },
    },
  });
}

/** What a Send email action's save asks of the server beyond the draft itself. */
export type EmailCommand = {
  /** The draft as the builder holds it, with the action in it. */
  readonly document: Readonly<Record<string, unknown>>;
  readonly step: string;
} & (
  | { readonly kind: 'copy' | 'sync'; readonly template: string }
  | { readonly kind: 'save'; readonly edit: SyncedEmailEdit }
);

/** Runs one command; answers the saved draft, and the template when the command saved one. */
export async function runEmailCommand(
  client: ReturnType<typeof apiIn>,
  draft: { readonly automationId: string; readonly baseDraftVersion: number },
  command: EmailCommand,
): Promise<{ readonly saved: AutomationDraftSaved; readonly template?: MessageTemplate }> {
  const target = { ...draft, step: command.step, document: command.document };
  if (command.kind === 'save') return saveSyncedEmail(client, { ...target, ...command.edit });
  const input = { ...target, template: command.template };
  return {
    saved: await (command.kind === 'copy'
      ? copyEmailTemplate(client, input)
      : syncEmailTemplate(client, input)),
  };
}
