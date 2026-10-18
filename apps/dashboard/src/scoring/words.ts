// What Manage Scoring, the contact's score and the builder's score step call things: each
// action, email event, channel and status, and a rule read as GoHighLevel reads it, "if an
// email is - Bounced". The choices are the contract's; only their names are here.
import { useLingui } from '@lingui/react/macro';
import type {
  appointmentStatuses,
  scoreEmailEvents,
  scoreReplyChannels,
  ScoreCalculation,
  ScoreRule,
  ScoreRuleAction,
  unavailableScoreActions,
} from '@repo/contracts';

type Names<Key extends string> = Readonly<Record<Key, string>>;

export interface ScoringWords {
  readonly actions: Names<ScoreRuleAction>;
  readonly unavailable: Names<(typeof unavailableScoreActions)[number]>;
  readonly events: Names<(typeof scoreEmailEvents)[number]>;
  readonly channels: Names<(typeof scoreReplyChannels)[number]>;
  readonly statuses: Names<(typeof appointmentStatuses)[number]>;
  readonly calculations: Names<ScoreCalculation>;
  /** The rule's Action column: what it scores, with its tag condition. */
  readonly sentence: (
    rule: Pick<ScoreRule, 'when' | 'hasTagId'>,
    tagName: (id: string) => string,
    formName: (id: string) => string,
  ) => string;
}

export function useScoringWords(): ScoringWords {
  const { t } = useLingui();
  const events = {
    bounced: t`Bounced`,
    unsubscribed: t`Unsubscribed`,
    complained: t`Complained (spam)`,
  };
  const channels = { email: t`Email`, sms: t`SMS`, webchat: t`Web chat` };
  const statuses = {
    booked: t`Booked`,
    confirmed: t`Confirmed`,
    cancelled: t`Cancelled`,
    no_show: t`No show`,
    completed: t`Showed`,
    invalid: t`Invalid`,
  };
  return {
    actions: {
      email_event: t`Email events`,
      contact_replied: t`Contact replied`,
      form_submitted: t`Form submitted`,
      appointment_booked: t`Appointment booked`,
      appointment_status: t`Appointment status changed`,
      contact_tag: t`Contact tag`,
      payment_received: t`Payment received`,
      trigger_link_clicked: t`Trigger link clicked`,
      contact_changed: t`Contact changed`,
    },
    unavailable: {
      email_opened: t`Email opened`,
      email_clicked: t`Email link clicked`,
      order_form_submission: t`Order form submission`,
      order_placed: t`Order placed`,
      survey_submitted: t`Survey submitted`,
    },
    events,
    channels,
    statuses,
    calculations: { add: t`Add points`, subtract: t`Subtract points` },
    sentence: (rule, tagName, formName) => {
      const { when } = rule;
      let what: string;
      switch (when.action) {
        case 'email_event': {
          const event = events[when.event];
          what = t`if an email is - ${event}`;
          break;
        }
        case 'contact_replied': {
          const channel = when.channel === null ? undefined : channels[when.channel];
          what =
            channel === undefined
              ? t`if a contact replies`
              : t`if a contact replies - by ${channel}`;
          break;
        }
        case 'form_submitted': {
          const form = when.formId === null ? undefined : formName(when.formId);
          what =
            form === undefined ? t`if a form is submitted` : t`if a form is submitted - ${form}`;
          break;
        }
        case 'appointment_booked':
          what = t`if an appointment is booked`;
          break;
        case 'appointment_status': {
          const status = statuses[when.status];
          what = t`if an appointment Status is - ${status}`;
          break;
        }
        case 'contact_tag': {
          const tag = tagName(when.tagId);
          what =
            when.change === 'added'
              ? t`if a tag is added - ${tag}`
              : t`if a tag is removed - ${tag}`;
          break;
        }
        case 'payment_received':
          what = t`if a payment is received`;
          break;
        case 'trigger_link_clicked':
          what = t`if a trigger link is clicked`;
          break;
        case 'contact_changed':
          what = t`if the contact is changed`;
          break;
      }
      if (rule.hasTagId === null) return what;
      const has = tagName(rule.hasTagId);
      return t`${what} and contact Has tag - ${has}`;
    },
  };
}
