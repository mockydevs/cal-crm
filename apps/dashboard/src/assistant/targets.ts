// Where a check, an activity row or "connect a provider" leads: the server names a kind of
// thing and its id, and the dashboard knows its own addresses. One function, so every kind
// the contract has is answered in one place. Pure, with tests beside it.
import type { AssistantTarget } from '@repo/contracts';

type Kind = AssistantTarget['kind'];

/** A page inside a business, and the search that opens one record on it. */
const places: Readonly<Record<Kind, (id: string | null) => string>> = {
  form: (id) => (id === null ? '/settings/forms' : `/settings/forms?form=${id}`),
  contact: (id) => (id === null ? '/contacts' : `/contacts/${id}`),
  company: (id) => (id === null ? '/contacts/companies' : `/contacts/companies/${id}`),
  deal: (id) => (id === null ? '/deals' : `/deals?deal=${id}`),
  conversation: (id) => (id === null ? '/inbox' : `/inbox?conversation=${id}`),
  automation: (id) => (id === null ? '/automations' : `/automations?automation=${id}`),
  automations: () => '/automations',
  calendar: (id) => (id === null ? '/settings/calendars' : `/settings/calendars/${id}`),
  pipeline: (id) => (id === null ? '/deals/pipelines' : `/deals/pipelines?pipeline=${id}`),
  // Fields and tags have no page of their own for one of them: the list they are in.
  field: () => '/settings/custom-fields',
  tag: () => '/settings/tags',
  ai_settings: () => '/settings/ai-models',
};

/** The dashboard's address of what a target names, in the business named `slug`. */
export function targetHref(slug: string, target: Pick<AssistantTarget, 'kind' | 'id'>): string {
  const id = target.id === null ? null : encodeURIComponent(target.id);
  return `/b/${encodeURIComponent(slug)}${places[target.kind](id)}`;
}

/**
 * The address to link a target to, or null when it is the page the person is already on:
 * a link that goes nowhere is not drawn.
 */
export function targetLink(
  slug: string,
  target: Pick<AssistantTarget, 'kind' | 'id'> | null,
  here: string,
): string | null {
  if (target === null) return null;
  const href = targetHref(slug, target);
  return href === here ? null : href;
}
