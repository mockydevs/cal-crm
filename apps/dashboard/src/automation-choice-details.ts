// What each choice of a setting does, in a sentence, for the settings whose choices are
// shown as a list with one each: by the setting's key, then the choice's value. Kept with
// the controls that show them (automation-target-fields.tsx), away from the forms' own
// table, which the step panel reads before any of these are needed.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const choiceDetails: Readonly<Record<string, Readonly<Record<string, MessageDescriptor>>>> =
  {
    otherwise: {
      continue: msg`They go on to the next action, and the goal no longer applies to them.`,
      wait: msg`They stay here until one of the events happens, for up to 365 days, then go on.`,
      end: msg`Their run ends here. Nothing after the goal happens for them.`,
    },
    from: {
      current: msg`The contact leaves this automation here. No later step of it runs for them.`,
      automations: msg`Ends the contact's runs in the automations you choose. This one carries on.`,
      all_others: msg`Ends every other automation the contact is in, except any you list. This one carries on.`,
      all: msg`Ends every automation the contact is in, this one too, except any you list. No later step of this one runs for them.`,
    },
    how: {
      stopped: msg`One of that automation's own stop conditions ended it, such as the contact replying.`,
      removed: msg`A "Remove from automations" action took the contact out of it.`,
      completed: msg`The contact went through to its last action.`,
      failed: msg`One of its actions failed, and the run ended there.`,
    },
  };
