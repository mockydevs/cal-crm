// The words of the public booking page and of the page that manages an appointment. A
// catalog of its own (lingui.config.ts), fetched with those pages: nobody signed in to the
// dashboard reads them, so they are not in the catalog every page downloads. The catalog is
// merged into the language in use: nothing is replaced.
import { i18n, type Messages } from '@lingui/core';

type Catalogs = Readonly<Record<string, (() => Promise<{ messages: Messages }>) | undefined>>;

const booking: Catalogs = {
  en: () => import('./booking-locales/en/messages.po'),
};

export async function loadBookingWords(): Promise<void> {
  const load = booking[i18n.locale] ?? booking['en'];
  if (load === undefined) return;
  const { messages } = await load();
  i18n.load(i18n.locale, messages);
}
