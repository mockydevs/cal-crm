// The command bar: ⌘K or Ctrl+K anywhere in the app, or the Search button, opens it. It
// finds the business's contacts, companies and deals, its pages, and the businesses the
// person may enter, and goes to the one chosen, all by keyboard. What it lists is what the
// person may reach: records of the business they're in, and their own businesses.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { searchRecords, type FoundRecord } from '@repo/contracts';
import { CommandDialog, type CommandGroup } from '@repo/ui/components/command';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useMatch, useNavigate } from '@tanstack/react-router';
import {
  Building2,
  CornerDownLeft,
  FileText,
  BotMessageSquare,
  SquareKanban,
  User,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { setAssistantView } from './assistant/view-state';
import { meQuery, useBusinessInAddress } from './workspace';

/** The pages of a business the bar goes to, in the sidebar's order, then Settings'. */
type BusinessPage =
  | '/b/$slug'
  | '/b/$slug/inbox'
  | '/b/$slug/calendar'
  | '/b/$slug/contacts'
  | '/b/$slug/contacts/companies'
  | '/b/$slug/deals'
  | '/b/$slug/marketing/emails/campaigns'
  | '/b/$slug/marketing/emails/templates'
  | '/b/$slug/marketing/snippets'
  | '/b/$slug/marketing/trigger-links'
  | '/b/$slug/automations'
  | '/b/$slug/reports'
  | '/b/$slug/reports/attribution'
  | '/b/$slug/reports/appointments'
  | '/b/$slug/trash'
  | '/b/$slug/assistant'
  | '/b/$slug/settings'
  | '/b/$slug/settings/business'
  | '/b/$slug/settings/team'
  | '/b/$slug/deals/pipelines'
  | '/b/$slug/settings/custom-fields'
  | '/b/$slug/settings/custom-values'
  | '/b/$slug/settings/import'
  | '/b/$slug/settings/tags'
  | '/b/$slug/settings/lead-sources'
  | '/b/$slug/settings/lead-sources/tracking-links'
  | '/b/$slug/settings/lead-sources/check'
  | '/b/$slug/settings/apps'
  | '/b/$slug/settings/sign-in';

const businessPages: readonly { readonly to: BusinessPage; readonly label: MessageDescriptor }[] = [
  { to: '/b/$slug', label: msg`Dashboard` },
  { to: '/b/$slug/inbox', label: msg`Conversations` },
  { to: '/b/$slug/calendar', label: msg`Calendars` },
  { to: '/b/$slug/contacts', label: msg`Contacts` },
  { to: '/b/$slug/contacts/companies', label: msg`Companies` },
  { to: '/b/$slug/deals', label: msg`Opportunities` },
  { to: '/b/$slug/marketing/emails/campaigns', label: msg`Email Campaigns` },
  { to: '/b/$slug/marketing/emails/templates', label: msg`Email Templates` },
  { to: '/b/$slug/marketing/snippets', label: msg`Snippets` },
  { to: '/b/$slug/marketing/trigger-links', label: msg`Trigger Links` },
  { to: '/b/$slug/automations', label: msg`Automation` },
  { to: '/b/$slug/reports', label: msg`Reporting` },
  { to: '/b/$slug/reports/attribution', label: msg`Attribution report` },
  { to: '/b/$slug/reports/appointments', label: msg`Appointment report` },
  { to: '/b/$slug/trash', label: msg`Trash` },
  { to: '/b/$slug/assistant', label: msg`Assistant conversations` },
  { to: '/b/$slug/settings', label: msg`Settings` },
  { to: '/b/$slug/settings/business', label: msg`Business Profile` },
  { to: '/b/$slug/settings/team', label: msg`Users` },
  { to: '/b/$slug/deals/pipelines', label: msg`Pipelines` },
  { to: '/b/$slug/settings/custom-fields', label: msg`Custom Fields` },
  { to: '/b/$slug/settings/custom-values', label: msg`Custom Values` },
  { to: '/b/$slug/settings/import', label: msg`Import Data` },
  { to: '/b/$slug/settings/tags', label: msg`Tags` },
  { to: '/b/$slug/settings/lead-sources', label: msg`Lead Sources` },
  { to: '/b/$slug/settings/lead-sources/tracking-links', label: msg`Tracking links` },
  { to: '/b/$slug/settings/lead-sources/check', label: msg`Check a link` },
  { to: '/b/$slug/settings/apps', label: msg`Apps and API keys` },
  { to: '/b/$slug/settings/sign-in', label: msg`Sign-in and security` },
];

type Entry =
  | {
      readonly key: string;
      readonly kind: 'page';
      readonly label: string;
      readonly to: BusinessPage;
      readonly slug: string;
    }
  | { readonly key: string; readonly kind: 'agency'; readonly label: string }
  // Opens the assistant's panel on the page the person is on.
  | { readonly key: string; readonly kind: 'assistant'; readonly label: string }
  | {
      readonly key: string;
      readonly kind: 'business';
      readonly label: string;
      readonly slug: string;
    }
  | {
      readonly key: string;
      readonly kind: 'record';
      readonly label: string;
      readonly record: FoundRecord;
      readonly slug: string;
    };

const recordIcons: Readonly<Record<FoundRecord['kind'], LucideIcon>> = {
  contact: User,
  company: Building2,
  deal: SquareKanban,
};

/** What's typed, once typing pauses, so the API isn't asked for every key. */
function useSettled(value: string, delay = 150): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}

/** Whether a name holds what's typed, ignoring case. */
const holds = (label: string, typed: string, locale: string) =>
  label.toLocaleLowerCase(locale).includes(typed.toLocaleLowerCase(locale));

export interface CommandBarProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function CommandBar({ open, onOpenChange }: CommandBarProps): ReactElement {
  const { t, i18n } = useLingui();
  const me = useSuspenseQuery(meQuery).data;
  // The business the page is in, whose records it searches. None at the agency.
  const business = useBusinessInAddress();
  const navigate = useNavigate();
  // The full-screen view already is the assistant: there is no panel to open over it.
  const atAssistant =
    useMatch({ from: '/_app/b/$slug/assistant', shouldThrow: false }) !== undefined;
  const [typed, setTyped] = useState('');
  const search = useSettled(typed.trim());
  const found = useQuery({
    queryKey: ['b', business?.id, 'search', search],
    queryFn: () => apiIn(business?.id ?? '').request(searchRecords, { query: { q: search } }),
    enabled: open && business !== undefined && search !== '',
    staleTime: 30_000,
  });
  const text = typed.trim();
  // Only what was found for what's typed now, so Enter never follows an earlier search's.
  const records: Entry[] =
    business === undefined || text === '' || search !== text || found.data === undefined
      ? []
      : found.data.items.map((record) => ({
          key: record.id,
          kind: 'record',
          label: record.name ?? t`Unnamed contact`,
          record,
          slug: business.slug,
        }));
  const ofKind = (kind: FoundRecord['kind']) =>
    records.filter((entry) => entry.kind === 'record' && entry.record.kind === kind);
  const pages: Entry[] = [
    ...(business === undefined || atAssistant
      ? []
      : [{ key: 'assistant', kind: 'assistant', label: t`Ask the assistant` } as const]),
    ...(business === undefined
      ? []
      : businessPages.map((page): Entry => ({
          key: page.to,
          kind: 'page',
          label: i18n._(page.label),
          to: page.to,
          slug: business.slug,
        }))),
    ...(me.agencyStaff
      ? [{ key: 'agency', kind: 'agency', label: t`All businesses` } as const]
      : []),
  ].filter((entry) => holds(entry.label, text, i18n.locale));
  const businesses: Entry[] = me.businesses
    .filter((each) => each.id !== business?.id && holds(each.name, text, i18n.locale))
    .map((each) => ({ key: each.id, kind: 'business', label: each.name, slug: each.slug }));
  const groups: CommandGroup<Entry>[] = [
    { label: t`Contacts`, items: ofKind('contact') },
    { label: t`Companies`, items: ofKind('company') },
    { label: t`Deals`, items: ofKind('deal') },
    { label: t`Go to`, items: pages },
    { label: t`Businesses`, items: businesses },
  ].filter((group) => group.items.length > 0);
  const searching = text !== '' && business !== undefined && (search !== text || found.isFetching);

  const close = () => {
    onOpenChange(false);
    setTyped('');
  };
  const go = async (entry: Entry) => {
    close();
    if (entry.kind === 'page') await navigate({ to: entry.to, params: { slug: entry.slug } });
    else if (entry.kind === 'assistant') {
      if (business !== undefined) setAssistantView(business.id, { open: true });
    } else if (entry.kind === 'agency') await navigate({ to: '/agency' });
    else if (entry.kind === 'business')
      await navigate({ to: '/b/$slug', params: { slug: entry.slug } });
    else if (entry.record.kind === 'contact')
      await navigate({
        to: '/b/$slug/contacts/$contactId',
        params: { slug: entry.slug, contactId: entry.record.id },
      });
    else if (entry.record.kind === 'company')
      await navigate({
        to: '/b/$slug/contacts/companies/$companyId',
        params: { slug: entry.slug, companyId: entry.record.id },
      });
    else
      await navigate({
        to: '/b/$slug/deals',
        params: { slug: entry.slug },
        search: { deal: entry.record.id },
      });
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
      label={t`Command bar`}
      inputLabel={t`Search or go to`}
      placeholder={
        business === undefined
          ? t`Go to a business or page…`
          : t`Search contacts, companies, deals and pages…`
      }
      value={typed}
      onValueChange={setTyped}
      groups={groups}
      itemKey={(entry) => entry.key}
      itemText={(entry) => entry.label}
      renderItem={(entry) => {
        const Icon =
          entry.kind === 'record'
            ? recordIcons[entry.record.kind]
            : entry.kind === 'page'
              ? FileText
              : entry.kind === 'assistant'
                ? BotMessageSquare
                : Building2;
        const detail = entry.kind === 'record' ? entry.record.detail : null;
        return (
          <>
            <Icon aria-hidden className="size-[18px] text-muted-foreground" strokeWidth={1.8} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate">{entry.label}</span>
              {detail === null ? null : (
                <span className="truncate text-xs text-muted-foreground">{detail}</span>
              )}
            </span>
            <CornerDownLeft
              aria-hidden
              className="hidden size-4 text-muted-foreground in-data-highlighted:block"
            />
          </>
        );
      }}
      onSelect={(entry) => {
        void go(entry);
      }}
      empty={
        searching ? (
          <Trans>Searching…</Trans>
        ) : found.isError ? (
          <Trans>We couldn't search. Check your connection and try again.</Trans>
        ) : (
          <Trans>Nothing found for “{text}”.</Trans>
        )
      }
      status={searching ? t`Searching…` : undefined}
      hint={t`Use the up and down arrows to choose, Enter to go there, and Escape to close.`}
      closeLabel={t`Close the command bar`}
    />
  );
}
