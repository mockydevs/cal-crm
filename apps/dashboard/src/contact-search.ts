// What a contact page's address says: which panel is open beside the conversation (?view=,
// as GoHighLevel has it) and which part of the details shows (?tab=). The route validates
// its search with contactSearch, so this file stays small: it is loaded with the app, while
// the page itself is the route's own chunk. Only what this server has is listed: a panel
// joins when its data does.

/** The panels beside the conversation, in the rail's order. */
export const contactPanels = [
  'activity',
  'tasks',
  'notes',
  'appointments',
  'documents',
  'companies',
] as const;
export type ContactPanelName = (typeof contactPanels)[number];

/** What shows on a narrow screen, one at a time: the details, the conversation, or a panel. */
export const contactSections = ['details', 'conversation', ...contactPanels] as const;
export type ContactSection = (typeof contactSections)[number];

/** The parts of the details: All fields, DND and Actions. */
export const contactTabs = ['fields', 'dnd', 'actions'] as const;
export type ContactTab = (typeof contactTabs)[number];

export interface ContactSearch {
  readonly view?: ContactSection;
  /** All fields unless the address says otherwise. */
  readonly tab?: Exclude<ContactTab, 'fields'>;
}

function isSection(value: unknown): value is ContactSection {
  return contactSections.some((section) => section === value);
}

function isPanel(value: unknown): value is ContactPanelName {
  return contactPanels.some((panel) => panel === value);
}

/** The page's search parameters, for the route to validate: anything else is dropped. */
export function contactSearch(search: Record<string, unknown>): ContactSearch {
  const view = search['view'];
  const tab = search['tab'];
  return {
    ...(isSection(view) ? { view } : {}),
    ...(tab === 'dnd' || tab === 'actions' ? { tab } : {}),
  };
}

/** The one section a narrow screen shows: the details, until the address names another. */
export function sectionOf(search: ContactSearch): ContactSection {
  return search.view ?? 'details';
}

/** The panel a wide screen shows beside the details and the conversation: Activity first. */
export function panelOf(search: ContactSearch): ContactPanelName {
  return isPanel(search.view) ? search.view : 'activity';
}

export function tabOf(search: ContactSearch): ContactTab {
  return search.tab ?? 'fields';
}

/** The address's query string for a search, for a real link's href. */
export function contactSearchString(search: ContactSearch): string {
  const query = new URLSearchParams();
  if (search.view !== undefined) query.set('view', search.view);
  if (search.tab !== undefined) query.set('tab', search.tab);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
