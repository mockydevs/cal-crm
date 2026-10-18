// What email campaigns are handed by the modules they may not ask themselves: a contact's
// merge values and the fields a send can fill in (automations own both), who is on the team
// (tenancy), people's sign-in addresses (auth), and the install's settings.
import { readTeamPeople } from '@repo/module-auth';
import { contactValues, readTemplateFields } from '@repo/module-automation';
import type { CampaignOptions } from '@repo/module-messaging';

import { taskOptions } from './task-options.js';

export interface CampaignInstall {
  /** PUBLIC_URL. Without an https address no unsubscribe link can be made, so nothing is sent. */
  readonly publicUrl?: string | undefined;
  /** CAMPAIGN_AGENCY_DAILY_LIMIT: one agency's campaign emails in 24 hours; left out, no limit. */
  readonly agencyDailyLimit?: number | undefined;
}

/** The same options for the API's routes and the worker's tasks, so both decide alike. */
export const campaignOptions = (install: CampaignInstall = {}): CampaignOptions => ({
  values: contactValues,
  fields: (trx) => readTemplateFields(trx),
  publicUrl: install.publicUrl,
  people: { assignees: taskOptions.assignees },
  team: readTeamPeople,
  agencyDailyLimit: install.agencyDailyLimit,
});
