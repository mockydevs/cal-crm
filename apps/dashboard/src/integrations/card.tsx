// One card of Settings → Integrations, as GoHighLevel draws its own: an icon tile, the name,
// one line on what it does, a menu, and one button. Under the description the card says
// where the integration stands in plain words: the account connected and who connected it,
// what needs someone, the account being checked, or that the install hasn't set it up.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type {
  IntegrationCategory,
  IntegrationConnection,
  IntegrationEntry,
  IntegrationPage,
} from '@repo/contracts';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { cn } from '@repo/ui/lib/utils';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Bot,
  CalendarDays,
  ClipboardList,
  Code,
  CreditCard,
  Inbox,
  ListChecks,
  MessageSquare,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';
import { useId, type ReactElement } from 'react';
import { RowMenu, type RowAction } from '../settings-list';
import { guideUrl } from './rules';
import { useIntegrationsWords } from './words';

const categoryIcons: Readonly<Record<IntegrationCategory, LucideIcon>> = {
  calendar_email: CalendarDays,
  phone_messaging: MessageSquare,
  ai: Bot,
  lead_intake: Inbox,
  payments_accounting: CreditCard,
  ecommerce: ShoppingCart,
  productivity: ListChecks,
  forms: ClipboardList,
  developers: Code,
};

/** The settings page that keeps each integration living elsewhere. */
export const pagePlaces = {
  calendar_connections: '/b/$slug/settings/calendars/connections',
  email_services: '/b/$slug/settings/email',
  email_verification: '/b/$slug/settings/email',
  phone_system: '/b/$slug/settings/sms',
  ai_models: '/b/$slug/settings/ai-models',
  apps_and_api_keys: '/b/$slug/settings/apps',
} as const satisfies Record<IntegrationPage, string>;

/** Manage's colours: GoHighLevel's green, at the shade that reads on its tint. */
export const manageClassName =
  'border border-success-line bg-success-subtle text-success hover:bg-success-subtle hover:brightness-95';

export interface CardActions {
  /** The button or menu an action came from: the keyboard goes back to it afterwards. */
  readonly remember: (trigger: HTMLElement | null) => void;
  /** Connect, Reconnect or Add account: the provider's sign-in, or the key's dialog. */
  readonly onConnect: (entry: IntegrationEntry) => void;
  /** The Manage panel, opened at the top or on its activity. */
  readonly onManage: (entry: IntegrationEntry, activity: boolean) => void;
  readonly onDisconnect: (entry: IntegrationEntry, connection: IntegrationConnection) => void;
}

export function IntegrationCard({
  entry,
  slug,
  canManage,
  agencyStaff,
  busy,
  actions,
}: {
  readonly entry: IntegrationEntry;
  readonly slug: string;
  /** Whether the reader may connect and change what is connected on this page. */
  readonly canManage: boolean;
  /** The operator's guide is for the agency's staff, who run the install. */
  readonly agencyStaff: boolean;
  /** A connect is on its way: its button waits. */
  readonly busy: boolean;
  readonly actions: CardActions;
}): ReactElement {
  const { t, i18n } = useLingui();
  const words = useIntegrationsWords();
  const navigate = useNavigate();
  const headingId = useId();
  const name = words.nameOf(entry);
  const Icon = categoryIcons[entry.category];
  const elsewhere = entry.auth === 'elsewhere';
  const [only, ...others] = entry.connections;
  const single = only !== undefined && others.length === 0 ? only : undefined;
  const guide = entry.operatorGuide === null ? undefined : guideUrl(entry.operatorGuide);

  const accountLine = ((): string | undefined => {
    if (entry.state !== 'connected' && entry.state !== 'needs_attention') return undefined;
    if (elsewhere) {
      if (entry.label !== null) return entry.label;
      return entry.connected === 0
        ? undefined
        : plural(entry.connected, { one: '# account connected', other: '# accounts connected' });
    }
    if (single !== undefined) return single.accountLabel ?? t`Account connected`;
    return plural(entry.connections.length, {
      one: '# account connected',
      other: '# accounts connected',
    });
  })();
  const who = single?.connectedBy ?? null;
  const when =
    single === undefined
      ? ''
      : new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
          new Date(single.connectedAt),
        );
  const byLine =
    elsewhere || single === undefined || who === null || entry.state === 'connecting'
      ? undefined
      : t`Connected by ${who} · ${when}`;
  const attentionLine = ((): string | undefined => {
    if (entry.state !== 'needs_attention') return undefined;
    if (elsewhere)
      return plural(entry.attention, {
        one: '# connection needs attention',
        other: '# connections need attention',
      });
    return (
      entry.connections.find((each) => each.status === 'needs_attention')?.errorDetail ??
      t`An account needs attention.`
    );
  })();

  const menu: RowAction[] = [];
  if (elsewhere && entry.page !== null) {
    const page = entry.page;
    const pageName = words.pages[page];
    menu.push({
      label: t`Open ${pageName}`,
      immediate: true,
      onSelect: () => {
        void navigate({ to: pagePlaces[page], params: { slug } });
      },
    });
  } else if (!elsewhere && canManage) {
    if (guide !== undefined)
      menu.push({
        label: t`Documentation`,
        immediate: true,
        onSelect: () => {
          window.open(guide, '_blank', 'noopener,noreferrer');
        },
      });
    if (entry.connections.length > 0) {
      if (entry.auth === 'oauth2' && entry.mayManage)
        menu.push({
          label: t`Reconnect`,
          immediate: true,
          onSelect: () => {
            actions.onConnect(entry);
          },
        });
      menu.push({
        label: t`Activity`,
        onSelect: () => {
          actions.onManage(entry, true);
        },
      });
      if (single !== undefined)
        menu.push({
          label: t`Disconnect`,
          destructive: true,
          onSelect: () => {
            actions.onDisconnect(entry, single);
          },
        });
    }
  }

  let button: ReactElement | null = null;
  if (elsewhere) {
    if (entry.mayManage && entry.page !== null) {
      const connect = entry.state === 'not_connected';
      button = (
        <Link
          to={pagePlaces[entry.page]}
          params={{ slug }}
          aria-label={connect ? t`Connect ${name}` : t`Manage ${name}`}
          className={cn(
            buttonVariants({ variant: connect ? 'primary' : 'secondary' }),
            connect ? undefined : manageClassName,
          )}
        >
          {connect ? <Trans>Connect</Trans> : <Trans>Manage</Trans>}
        </Link>
      );
    }
  } else if (canManage) {
    const reconnect = entry.state === 'needs_attention' && entry.auth === 'oauth2';
    button =
      entry.connections.length === 0 ? (
        entry.mayManage ? (
          <Button
            aria-label={t`Connect ${name}`}
            disabled={busy}
            onClick={(event) => {
              actions.remember(event.currentTarget);
              actions.onConnect(entry);
            }}
          >
            <Trans>Connect</Trans>
          </Button>
        ) : null
      ) : (
        <>
          <Button
            variant="secondary"
            className={manageClassName}
            aria-label={t`Manage ${name}`}
            onClick={(event) => {
              actions.remember(event.currentTarget);
              actions.onManage(entry, false);
            }}
          >
            <Trans>Manage</Trans>
          </Button>
          {reconnect && entry.mayManage ? (
            <Button
              variant="secondary"
              aria-label={t`Reconnect ${name}`}
              disabled={busy}
              onClick={(event) => {
                actions.remember(event.currentTarget);
                actions.onConnect(entry);
              }}
            >
              <Trans>Reconnect</Trans>
            </Button>
          ) : null}
        </>
      );
  }

  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        'flex h-full min-w-0 flex-col gap-3 rounded-card border p-4',
        entry.available ? 'bg-card' : 'bg-muted',
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            entry.available ? 'bg-accent text-link' : 'bg-card text-muted-foreground',
          )}
        >
          <Icon className="size-5" strokeWidth={1.8} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={headingId} className="text-base font-medium wrap-anywhere">
            {name}
          </h2>
          <p className="line-clamp-2 text-sm text-muted-foreground">{words.descriptionOf(entry)}</p>
        </div>
        {menu.length === 0 ? null : (
          <RowMenu label={t`Actions for ${name}`} actions={menu} onOpen={actions.remember} />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 text-sm">
        {entry.available ? null : (
          <>
            <p className="text-body">
              <Trans>Your administrator hasn't set this up.</Trans>
            </p>
            {agencyStaff && guide !== undefined ? (
              <a
                href={guide}
                target="_blank"
                rel="noopener noreferrer"
                className="w-fit font-medium text-link underline-offset-2 hover:underline"
              >
                <Trans>
                  Operator setup guide <span className="sr-only">(opens in a new tab)</span>
                </Trans>
              </a>
            ) : null}
          </>
        )}
        {entry.state === 'connecting' ? (
          <p className="text-body">
            <Trans>Checking the account…</Trans>
          </p>
        ) : null}
        {accountLine === undefined ? null : (
          <p className="font-medium wrap-anywhere text-foreground">{accountLine}</p>
        )}
        {byLine === undefined ? null : <p className="text-muted-foreground">{byLine}</p>}
        {attentionLine === undefined ? null : (
          <p className="font-medium wrap-anywhere text-destructive">{attentionLine}</p>
        )}
      </div>
      {button === null ? null : <div className="flex flex-wrap gap-2">{button}</div>}
    </article>
  );
}
