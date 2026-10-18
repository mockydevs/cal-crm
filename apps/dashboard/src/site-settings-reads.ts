// What a site's Settings read of other parts of the CRM once its own domain can do
// something (sites-rules.ts, SITE_STAGES.connectedDomains): the domains already connected,
// and the chat widgets. Apart from the Settings tab, and fetched only when it asks: each
// operation comes with its part of the contract, which the tab would otherwise carry while
// nothing on it uses them (scripts/check-budget.mjs).
import {
  listSiteDomains,
  listWebchatWidgets,
  type SiteDomainList,
  type WebchatWidget,
} from '@repo/contracts';
import { apiIn } from './api';

export const readSiteDomains = (businessId: string): Promise<SiteDomainList> =>
  apiIn(businessId).request(listSiteDomains, {});

export const readChatWidgets = (businessId: string): Promise<{ data: WebchatWidget[] }> =>
  apiIn(businessId).request(listWebchatWidgets, {});
