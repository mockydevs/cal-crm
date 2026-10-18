// What ends an automation for a contact, in words: one sentence for each event a stop
// condition can name. On its own, with nothing else of the builder, because a record's page
// says the same words about a run that stopped early.
import { t } from '@lingui/core/macro';

const stopSummaries: Readonly<Record<string, (from: string | undefined) => string>> = {
  'message.received': (from) =>
    from === 'contact'
      ? t`They reply`
      : from === 'team'
        ? t`Someone on the team messages them`
        : t`A message arrives, from them or from the team`,
  'form.submitted': () => t`They submit a form`,
  'appointment.booked': () => t`They book an appointment`,
  'appointment.status_changed': () => t`Their appointment's status changes`,
  'deal.stage_changed': () => t`Their opportunity moves to another stage`,
  'deal.closed': () => t`Their opportunity is won or lost`,
  'field.changed': () => t`One of their fields changes`,
  'tag.added': () => t`A tag is added to them`,
};

/** The events that have words here: every one a stop condition can name. */
export const stopEvents: readonly string[] = Object.keys(stopSummaries);

/**
 * The event as a sentence, completing "Stops as soon as"; nothing for an event not known
 * here. A stop on a message can ask for a reply to what this run itself sent.
 */
export function stopEventWords(
  event: string,
  from: string | undefined,
  repliedTo?: string,
): string | undefined {
  if (event === 'message.received' && repliedTo === 'this_run')
    return t`They reply to a message this automation sent them`;
  return Object.hasOwn(stopSummaries, event) ? stopSummaries[event]?.(from) : undefined;
}
