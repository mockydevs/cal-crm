// Reads whether this install serves public pages (`getSitePublicStatus`). Apart from the
// pages that ask, and fetched by them when they do: the operation comes with the whole of
// the Sites pages' contract, which the funnel's page and the editor's canvas would
// otherwise carry in their own code for this one question (scripts/check-budget.mjs).
import { getSitePublicStatus, type SitePublicStatus } from '@repo/contracts';
import { apiIn } from './api';

export const readPublicStatus = (businessId: string): Promise<SitePublicStatus> =>
  apiIn(businessId).request(getSitePublicStatus, {});
