// Phone settings and history load their own catalog beside their pages, as Forms/Sites
// do. Keep feature text out of the catalog every dashboard visitor downloads.
import { i18n, type Messages } from '@lingui/core';

const catalogs: Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>> = {
  en: () => import('./phone-locales/en/messages.po'),
};
export async function loadPhoneWords(): Promise<void> {
  const locale = i18n.locale;
  const load = catalogs[locale] ?? catalogs['en'];
  if (load === undefined) return;
  const { messages } = await load();
  i18n.load(locale, messages);
}
