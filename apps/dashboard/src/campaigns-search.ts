// What Marketing → Emails → Campaigns keeps in its address: the folder, the status and the
// search. Apart from the page because the route reads its address before the page's code
// arrives: only this much is in the first load, and no contract schema is read here.

export const campaignStatusChoices = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'cancelled',
  'failed',
] as const;

export interface CampaignsSearch {
  /** A folder's id, or root for the campaigns in no folder; left out for every campaign. */
  readonly folder?: string;
  readonly status?: (typeof campaignStatusChoices)[number];
  readonly q?: string;
}

const FOLDER_ID = /^cfld_[0-9a-z]{26}$/;

export function campaignsSearchOf(search: Record<string, unknown>): CampaignsSearch {
  const folder =
    typeof search['folder'] === 'string' &&
    (search['folder'] === 'root' || FOLDER_ID.test(search['folder']))
      ? search['folder']
      : undefined;
  const status = campaignStatusChoices.find((each) => each === search['status']);
  const q = typeof search['q'] === 'string' ? search['q'].trim().slice(0, 120) : '';
  return {
    ...(folder === undefined ? {} : { folder }),
    ...(status === undefined ? {} : { status }),
    ...(q === '' ? {} : { q }),
  };
}
