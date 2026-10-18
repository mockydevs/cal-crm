import { listAutomations, type AutomationList } from '@repo/contracts';
import { apiIn } from './api';

/** Read the optional workflow filter only after the manual queue allows access. */
export function readWorkflows(
  businessId: string,
  after: string | undefined,
): Promise<AutomationList> {
  return apiIn(businessId).request(listAutomations, {
    query: after === undefined ? {} : { after },
  });
}
