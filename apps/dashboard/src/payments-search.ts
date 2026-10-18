// What a Payments page's address may say beside its path. On its own, and with nothing
// imported, because the route checks its address before the page is fetched: everything in
// this file is part of what every visitor downloads first.

/** Who a quote or an invoice being started is for, when it is started from their page. */
export interface PaymentsSearch {
  /** The contact's id. */
  readonly contact?: string;
  /** The opportunity's id. */
  readonly deal?: string;
}

const contactId = /^con_[0-9a-z]{26}$/;
const dealId = /^deal_[0-9a-z]{26}$/;

export function paymentsSearchOf(search: Record<string, unknown>): PaymentsSearch {
  const { contact, deal } = search;
  return {
    ...(typeof contact === 'string' && contactId.test(contact) ? { contact } : {}),
    ...(typeof deal === 'string' && dealId.test(deal) ? { deal } : {}),
  };
}
