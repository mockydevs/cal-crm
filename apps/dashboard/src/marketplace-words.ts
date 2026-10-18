// The App Marketplace pages and the agency's Marketplace apps settings say their words
// nowhere else: a catalog of their own, fetched with the pages, as Phone and Forms do. Keep
// feature text out of the catalog every dashboard visitor downloads.
import { i18n, type Messages } from '@lingui/core';

const catalogs: Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>> = {
  en: () => import('./marketplace-locales/en/messages.po'),
};

export async function loadMarketplaceWords(): Promise<void> {
  const locale = i18n.locale;
  const load = catalogs[locale] ?? catalogs['en'];
  if (load === undefined) return;
  const { messages } = await load();
  i18n.load(locale, messages);
}
