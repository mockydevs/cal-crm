// What Settings → Integrations calls things: each category, an account's status, what
// happened to it, the page an integration lives on, and the cards the catalogue ships, in
// the reader's language. A provider the catalogue doesn't know is shown in the server's
// words. The choices are the contract's; only their names are here.
import { useLingui } from '@lingui/react/macro';
import type {
  IntegrationActivityKind,
  IntegrationCategory,
  IntegrationConnectionStatus,
  IntegrationConnectOutcome,
  IntegrationEntry,
  IntegrationPage,
} from '@repo/contracts';

type Names<Key extends string> = Readonly<Record<Key, string>>;

export interface IntegrationsWords {
  readonly categories: Names<IntegrationCategory>;
  readonly statuses: Names<IntegrationConnectionStatus>;
  readonly activity: Names<IntegrationActivityKind>;
  readonly pages: Names<IntegrationPage>;
  /** A card's name and description: the catalogue's in the reader's words, else the server's. */
  readonly nameOf: (entry: Pick<IntegrationEntry, 'key' | 'name'>) => string;
  readonly descriptionOf: (entry: Pick<IntegrationEntry, 'key' | 'description'>) => string;
  /** What the page says when the provider's sign-in sends the browser back. */
  readonly outcome: (outcome: IntegrationConnectOutcome, name: string) => string;
}

export function useIntegrationsWords(): IntegrationsWords {
  const { t } = useLingui();
  const known: Readonly<Record<string, { readonly name: string; readonly description: string }>> = {
    google_calendar: {
      name: t`Google Calendar`,
      description: t`Two-way sync for each team member: bookings go into their calendar, and busy time keeps slots free.`,
    },
    mailboxes: {
      name: t`Email Services`,
      description: t`Connect any mailbox to send from it and read its replies into Conversations.`,
    },
    emailable: {
      name: t`Email Verification`,
      description: t`Check email addresses with Emailable before anything is sent to them.`,
    },
    twilio: {
      name: t`Phone System`,
      description: t`Text messages and calls through your own Twilio account.`,
    },
    ai_models: {
      name: t`AI Models`,
      description: t`Your own keys for Anthropic, OpenAI or a model server of your own.`,
    },
    apps_and_api_keys: {
      name: t`Apps and API keys`,
      description: t`Keys for your own code, Zapier, Make or n8n, and the marketplace apps you installed.`,
    },
  };
  return {
    categories: {
      calendar_email: t`Calendar & email`,
      phone_messaging: t`Phone & messaging`,
      ai: t`AI`,
      lead_intake: t`Lead intake`,
      payments_accounting: t`Payments & accounting`,
      ecommerce: t`E-commerce`,
      productivity: t`Productivity`,
      forms: t`Forms`,
      developers: t`Developers`,
    },
    statuses: {
      connecting: t`Checking the account`,
      connected: t`Working`,
      needs_attention: t`Needs attention`,
      disconnected: t`Disconnected`,
    },
    activity: {
      connected: t`Connected`,
      confirmed: t`Account confirmed`,
      check_ok: t`Checked: working`,
      check_failed: t`Check failed`,
      webhook_received: t`Received an update`,
      settings_changed: t`Options changed`,
      disconnected: t`Disconnected`,
      revoked: t`Access removed`,
    },
    pages: {
      calendar_connections: t`Calendars`,
      email_services: t`Email Services`,
      phone_system: t`Phone System`,
      email_verification: t`Email Services`,
      ai_models: t`AI Models`,
      apps_and_api_keys: t`Apps and API keys`,
    },
    nameOf: (entry) => known[entry.key]?.name ?? entry.name,
    descriptionOf: (entry) => known[entry.key]?.description ?? entry.description,
    outcome: (outcome, name) => {
      switch (outcome) {
        case 'connected':
          return t`${name} is connected. Checking the account…`;
        case 'denied':
          return t`Connecting ${name} was cancelled.`;
        case 'scopes_missing':
          return t`${name} wasn't connected: allow everything it asks for, then try again.`;
        case 'expired':
          return t`That sign-in took too long or was already used. Try again.`;
        case 'failed':
          return t`${name} couldn't be connected. Try again.`;
      }
    },
  };
}
