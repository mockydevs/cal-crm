// The forms module: the form builder's API, the public surface the embed calls, and
// submissions into contacts. It owns the forms schema. Contacts, custom field values and
// consent are written through the modules that own them.
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  archiveForm,
  createForm,
  discardFormSubmission,
  getForm,
  getFormAnalytics,
  getFormPreview,
  listForms,
  listFormSubmissions,
  parseInput,
  previewLeadSource,
  publishForm,
  restoreForm,
  unpublishForm,
  updateForm,
} from '@repo/contracts';
import type { Invocation, Proposable } from '@repo/commands';
import type { AssistantCheck } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';

import { readFormAnalytics } from './analytics.js';
import { formChecks } from './checks.js';
import { createFormCommands, readForm, readFormPreview, readForms } from './forms.js';
import { readLeadSourcePreview } from './lead-source-preview.js';
import { createFormProposables } from './proposals.js';
import { discardSubmissionCommand, readSubmissions } from './submissions.js';

export { FORM_SCRIPT_PATH, hostedFormUrl, readFormKeys, readFormNames } from './forms.js';
export {
  createPublicFormHandlers,
  ownOrigin,
  type FormAdmission,
  type FormRefusal,
  type PublicFormHandlers,
  type PublicFormOptions,
  type PublicFormRequest,
} from './public.js';

export { formChecks } from './checks.js';
export { createBookingShownProof, type BookingShownProof } from './booking-proof.js';
export {
  ALTCHA_POLICY,
  createAltchaBotChallenge,
  toAltchaChallenge,
  type BotChallenge,
} from './bot-challenge.js';

/**
 * What an assistant may propose about a form: publishing its draft, which a person
 * confirms. Given the install's public address, for the link and the embed line a published
 * form answers with.
 */
export function formProposables(publicUrl: string): readonly Proposable[] {
  return createFormProposables(createFormCommands(publicUrl));
}

export interface FormCheckOptions {
  /** The install's public address, as the form routes are given it. */
  readonly publicUrl: string;
  /**
   * How many running workflows start when this form is sent, from the module that owns
   * workflows. Left out, nothing is said about workflows.
   */
  readonly listeners?: (trx: DatabaseTransaction, formPublicId: string) => Promise<number>;
}

/**
 * One form's checks for the in-app assistant, with its name: its own problems as blockers,
 * then what it usually has and lacks. Worked out with no model, as anyone in the business
 * may read the form. A form that is not there is a NotFoundError.
 */
export async function readFormChecks(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
  options: FormCheckOptions,
): Promise<{ readonly id: string; readonly name: string; readonly checks: AssistantCheck[] }> {
  const form = await readForm(trx, invocation, publicId, options.publicUrl);
  const listeners = await options.listeners?.(trx, form.id);
  return { id: form.id, name: form.name, checks: formChecks(form, listeners) };
}

export interface FormRouteOptions {
  /**
   * Keys the links that preview a draft: the server's public intake secret, the one the
   * public handlers are given. Left out, a preview is refused: there is nothing to show
   * it on.
   */
  readonly previewSecret?: string | undefined;
  /** The clock, in milliseconds. Tests pass their own. */
  readonly now?: (() => number) | undefined;
}

/**
 * The admin API's routes for forms, given the install's public address for the snippet,
 * the form's own page and the preview of its draft.
 */
export function createFormRoutes(
  publicUrl: string,
  options: FormRouteOptions = {},
): readonly ApiRoute[] {
  const commands = createFormCommands(publicUrl);
  const list = {
    endpoint: listForms,
    run: ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(listForms.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readForms(trx, invocation, {
          after: input.after,
          limit: input.limit,
          archived: input.archived === 'true',
        }),
      );
    },
  } satisfies Route<typeof listForms>;
  const read = {
    endpoint: getForm,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getForm.params, params);
      return withTenant(db, invocation.context, (trx) => readForm(trx, invocation, id, publicUrl));
    },
  } satisfies Route<typeof getForm>;
  const create = {
    endpoint: createForm,
    command: commands.create,
    run: ({ invocation, body }, services) =>
      runCommand(services, commands.create, body, invocation),
  } satisfies Route<typeof createForm>;
  const update = {
    endpoint: updateForm,
    command: commands.update,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        commands.update,
        { ...parseInput(updateForm.body, body), ...parseInput(updateForm.params, params) },
        invocation,
      ),
  } satisfies Route<typeof updateForm>;
  // Publish, unpublish, archive and restore each take the form and the revision it was at,
  // and answer with the form: the commands' own type says so.
  const change = (
    endpoint: typeof publishForm | typeof unpublishForm | typeof archiveForm | typeof restoreForm,
    command: (typeof commands)['publish'],
  ): ApiRoute => ({
    endpoint,
    command,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        command,
        { ...parseInput(endpoint.body, body), ...parseInput(endpoint.params, params) },
        invocation,
      ),
  });
  const submissions = {
    endpoint: listFormSubmissions,
    run: ({ invocation, params, query }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(listFormSubmissions.params, params);
      const input = parseInput(listFormSubmissions.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readSubmissions(trx, invocation, id, input),
      );
    },
  } satisfies Route<typeof listFormSubmissions>;
  const discard = {
    endpoint: discardFormSubmission,
    command: discardSubmissionCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        discardSubmissionCommand,
        parseInput(discardFormSubmission.params, params),
        invocation,
      ),
  } satisfies Route<typeof discardFormSubmission>;
  const preview = {
    endpoint: getFormPreview,
    run: ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getFormPreview.params, params);
      return withTenant(db, invocation.context, (trx) =>
        readFormPreview(trx, invocation, id, {
          publicUrl,
          secret: options.previewSecret,
          now: options.now,
        }),
      );
    },
  } satisfies Route<typeof getFormPreview>;
  const analytics = {
    endpoint: getFormAnalytics,
    run: ({ invocation, params, query }, { db }) => {
      requireBusiness(invocation.context);
      const { id } = parseInput(getFormAnalytics.params, params);
      const range = parseInput(getFormAnalytics.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readFormAnalytics(trx, invocation, id, range),
      );
    },
  } satisfies Route<typeof getFormAnalytics>;
  // "Check a link": reads an address as a submission would; nothing is stored.
  const checkLink = {
    endpoint: previewLeadSource,
    run: ({ invocation, body }, { db }) => {
      requireBusiness(invocation.context);
      const input = parseInput(previewLeadSource.body, body);
      return withTenant(db, invocation.context, (trx) =>
        readLeadSourcePreview(trx, invocation, input),
      );
    },
  } satisfies Route<typeof previewLeadSource>;
  return [
    checkLink,
    list,
    create,
    read,
    update,
    change(publishForm, commands.publish),
    change(unpublishForm, commands.unpublish),
    change(archiveForm, commands.archive),
    change(restoreForm, commands.restore),
    submissions,
    discard,
    preview,
    analytics,
  ];
}
