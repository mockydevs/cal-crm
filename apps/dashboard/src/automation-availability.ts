// Which steps and triggers a business can use yet: what the catalog lists, less what this
// install can't run and what the business hasn't set up. Kept apart from the builder's
// other rules (automation-rules.ts), which read the contract's validator: the panels that
// only offer choices don't bring the validator with them.
import type { AutomationSetup } from '@repo/contracts';

/**
 * Why a step can't be used here: something this business hasn't set up, or, for
 * `unavailable`, a step the catalog lists that the product doesn't run yet.
 */
export type MissingSetup =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'ai'
  | 'webhooks'
  /** Email verification is turned off in Settings → Email Services. */
  | 'verification'
  | 'unavailable'
  /** A step a workflow holds one of, which this one already has: a goal. */
  | 'only_one';

// As the validator's own rules (automations-validate.ts): a step the install can't run is
// refused, each message step needs its channel connected, each AI step an AI key, and a
// webhook call a signing secret, and an Email verification step needs verification on.
const MESSAGE_CHANNELS: Readonly<Record<string, 'email' | 'sms' | 'whatsapp'>> = {
  'email.send': 'email',
  'sms.send': 'sms',
  'whatsapp.send': 'whatsapp',
};

/** What the business has set up, of the things a step can need. */
export type SetupState = Pick<
  AutomationSetup,
  'channels' | 'ai' | 'webhooks' | 'emailVerification' | 'unavailableSteps'
>;

interface CatalogStep {
  readonly type: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
}

/** The triggers a business can start an automation with: those something fires. */
export function availableTriggers<Trigger extends { readonly type: string }>(
  triggers: readonly Trigger[],
  setup: Pick<AutomationSetup, 'unavailableTriggers'>,
): Trigger[] {
  return triggers.filter((trigger) => !setup.unavailableTriggers.includes(trigger.type));
}

/** Why a step can't be used here yet, or nothing when it can. */
export function missingSetupOf(
  step: Pick<CatalogStep, 'type' | 'group'>,
  setup: SetupState,
): MissingSetup | undefined {
  // Not yet built comes first: connecting a channel would not make such a step run.
  if (setup.unavailableSteps.includes(step.type)) return 'unavailable';
  const channel = Object.hasOwn(MESSAGE_CHANNELS, step.type)
    ? MESSAGE_CHANNELS[step.type]
    : undefined;
  if (channel !== undefined && !setup.channels[channel]) return channel;
  if (step.group === 'ai' && !setup.ai) return 'ai';
  // Only a plain no: a server that doesn't say leaves it to the server to refuse.
  if (step.type === 'email.verify' && setup.emailVerification === false) return 'verification';
  return step.type === 'webhook.call' && !setup.webhooks ? 'webhooks' : undefined;
}

export interface StepPicker<Step extends CatalogStep> {
  /** The steps to choose from, by group, in the catalog's order. */
  readonly groups: readonly { readonly group: string; readonly steps: readonly Step[] }[];
  /** Steps that cannot yet be authored, with the capability or setup they need. */
  readonly unavailable: readonly { readonly step: Step; readonly missing: MissingSetup }[];
}

/**
 * Implemented email and SMS actions can be authored before their channels are connected.
 * Publishing and dispatch still validate sending readiness independently.
 */
export function stepPicker<Step extends CatalogStep>(
  steps: readonly Step[],
  groups: readonly string[],
  setup: SetupState,
  /** Step types the workflow already has its one of. */
  taken: readonly string[] = [],
): StepPicker<Step> {
  const unavailable = steps.flatMap((step) => {
    const missing =
      missingSetupOf(step, setup) ?? (taken.includes(step.type) ? 'only_one' : undefined);
    return missing === undefined || missing === 'email' || missing === 'sms'
      ? []
      : [{ step, missing }];
  });
  const blocked = new Set(unavailable.map(({ step }) => step.type));
  return {
    groups: groups
      .map((group) => ({
        group,
        steps: steps.filter((step) => step.group === group && !blocked.has(step.type)),
      }))
      .filter(({ steps: available }) => available.length > 0),
    unavailable,
  };
}
