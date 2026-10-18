// How one entry of an audit log is put into words: what the command did, who ran it and
// when, whether the assistant proposed it, and the reason kept with it. A record's own log
// (contact-audit-log.tsx) and the business's log in Settings (audit-logs.tsx) both show an
// entry through this, so the two never say it differently.
import { Trans, useLingui } from '@lingui/react/macro';
import type { AuditEntry } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import type { ReactElement } from 'react';

import { useActorLabel } from './activity';

/** The reason kept with a change, under whichever name its command gave it. */
export function auditReasonOf(entry: AuditEntry): string | undefined {
  const reason = entry.detail['reason'] ?? entry.detail['doNotContactReason'];
  return typeof reason === 'string' && reason.trim() !== '' ? reason : undefined;
}

/** What a command did, in words: its own when it has them, or its name spelled out. */
export function useCommandLabel(): (command: string) => string {
  const { t } = useLingui();
  const commands: Readonly<Record<string, string>> = {
    'contact.create': t`Contact created`,
    'contact.update': t`Contact changed`,
    'contact.trash': t`Contact moved to trash`,
    'contact.restore': t`Contact restored`,
    'contact.set_dnd': t`Do not disturb changed`,
    'contact.assign_owner': t`Owner changed`,
    'contact.add_followers': t`Followers added`,
    'contact.remove_followers': t`Followers removed`,
    'contact.add_address': t`Address added`,
    'contact.update_address': t`Address changed`,
    'contact.remove_address': t`Address removed`,
  };
  return (command) => commands[command] ?? command.replace(/[._]/g, ' ');
}

/** One entry: what happened, who did it and when, and the reason when one was given. */
export function AuditEntrySummary({ entry }: { readonly entry: AuditEntry }): ReactElement {
  const { i18n } = useLingui();
  const actorLabel = useActorLabel();
  const commandLabel = useCommandLabel();
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const reason = auditReasonOf(entry);
  return (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">{commandLabel(entry.command)}</span>
        {entry.proposed ? (
          <Badge variant="assistant" className="px-2 py-0.5 text-xs">
            <Trans>Proposed by the assistant</Trans>
          </Badge>
        ) : null}
      </span>
      <span className="text-muted-foreground">
        {actorLabel(entry.actor)} ·{' '}
        <time dateTime={entry.at}>{dates.format(new Date(entry.at))}</time>
      </span>
      {reason === undefined ? null : (
        <span className="wrap-anywhere text-body">
          <Trans>Reason: {reason}</Trans>
        </span>
      )}
    </>
  );
}
