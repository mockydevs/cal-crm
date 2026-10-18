// The Merge Contacts dialog with its words, fetched when Merge is first pressed: the contact
// list, Manage Duplicates and the contact page download none of it until then.
import { lazy } from 'react';

export const ContactMergeDialog = lazy(async () => {
  const [dialog, words] = await Promise.all([import('./dialog'), import('./words')]);
  await words.loadContactMergeWords();
  return dialog;
});
