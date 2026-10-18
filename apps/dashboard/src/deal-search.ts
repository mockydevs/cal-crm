// What the opportunities page's address says about the dialog over the list: which
// opportunity is open (?deal=) and which part of it shows (?section=). On its own so the
// route can check its address without loading the dialog.

/** In the address for the dialog that adds an opportunity. */
export const NEW_DEAL = 'new';

/** The parts of the dialog, in the order its left column lists them. */
export const dealSections = ['details', 'tasks', 'notes', 'activity'] as const;
export type DealSection = (typeof dealSections)[number];
