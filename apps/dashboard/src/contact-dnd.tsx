// The contact page's DND part: do not disturb for every channel or one channel at a time,
// and inbound do not disturb, then what this server has beside GoHighLevel's switches: the
// time zone quiet hours follow, do not contact with its confirmation, and consent by
// channel and purpose with its proof. Fetched when the part is first opened.
import type { ReactElement } from 'react';
import { ConsentPanel } from './consent-panel';
import { ContactDndSwitches } from './contact-dnd-switches';
import { ContactPreferences } from './contact-preferences';

const cardClassName = 'min-w-0 rounded-lg border border-border bg-card p-3.5';

export default function ContactDnd({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  readonly readOnly: boolean;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className={cardClassName}>
        <ContactDndSwitches contactId={contactId} readOnly={readOnly} />
      </div>
      <div className={cardClassName}>
        <ContactPreferences contactId={contactId} readOnly={readOnly} />
      </div>
      <div className={cardClassName}>
        <ConsentPanel contactId={contactId} readOnly={readOnly} />
      </div>
    </div>
  );
}
