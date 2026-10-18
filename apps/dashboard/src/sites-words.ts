// The words of the Sites pages and of the page editor. Each is a catalog of its own
// (lingui.config.ts), fetched with the pages that say them, so the sentences only they say
// are not in the catalog every page downloads, which is at its budget
// (scripts/check-budget.mjs). A catalog is merged into the language in use: nothing is
// replaced, and a word that both catalogs hold is the same word.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const sites: Catalogs = {
  en: () => import('./sites-locales/en/messages.po'),
};
const editor: Catalogs = {
  en: () => import('./site-editor/locales/en/messages.po'),
};

async function add(catalogs: Catalogs): Promise<void> {
  const load = catalogs[i18n.locale] ?? catalogs['en'];
  if (load === undefined) return;
  const { messages } = await load();
  i18n.load(i18n.locale, messages);
}

/** The words of the funnel and website lists, a site's own page, and its dialogs. */
export const loadSitesWords = (): Promise<void> => add(sites);

/** The page editor's words, and those of the Sites dialogs it shares (preview, publish). */
export async function loadSiteEditorWords(): Promise<void> {
  await Promise.all([add(sites), add(editor)]);
}
