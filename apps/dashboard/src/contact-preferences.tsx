import { Trans, useLingui } from '@lingui/react/macro';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { useRef, useState, type ReactElement } from 'react';
import { ContactPanel } from './contact-panels';
import ContactPreferenceForm from './contact-preferences-loader';
import {
  preferencesOf,
  zoneOption,
  type ContactPreferences as Preferences,
} from './contact-preferences-rules';
import { useContact } from './contacts';
import { useBusiness } from './workspace';

type Setting = 'timeZone' | 'doNotContact';

/**
 * A contact's time zone and do-not-contact setting, with what each means for sending.
 * People who may change contacts can set or remove the time zone, and turn do not contact
 * on or off with a reason and a confirmation. A change is based on the settings as the
 * form opened with them: if someone else changed them meanwhile, nothing is saved, and the
 * latest are shown instead.
 */
export function ContactPreferences({
  contactId,
  readOnly = false,
}: {
  readonly contactId: string;
  readonly readOnly?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const current = useContact(business.id, contactId);
  const contact = current.data;
  const preferences = preferencesOf(contact);
  // When a change was refused as out of date: the reading of the contact it was based on.
  const [refusedAt, setRefusedAt] = useState<number>();
  // Still that reading: the latest hasn't arrived, so nothing may be changed yet.
  const outdated = refusedAt !== undefined && refusedAt === current.dataUpdatedAt;
  const reload = () => {
    void current.refetch();
  };
  return (
    <ContactPanel title={t`Time zone and do not contact`}>
      {current.isPending ? (
        <p aria-live="polite">
          <Trans>Loading settings…</Trans>
        </p>
      ) : null}
      {contact === undefined && current.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            <Trans>The settings couldn't be loaded.</Trans>
          </p>
          <Button variant="secondary" size="small" onClick={reload}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {contact !== undefined && preferences === undefined ? (
        <p role="alert" className="text-sm">
          <Trans>This server didn't send the contact's time zone or do not contact setting.</Trans>
        </p>
      ) : null}
      {refusedAt === undefined ? null : outdated ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
          <p>
            <Trans>
              Someone else changed this contact while you had it open, so your change wasn't saved.
              Reload to see the latest before you change it.
            </Trans>
          </p>
          {current.isRefetchError && !current.isFetching ? (
            <p>
              <Trans>The latest couldn't be loaded. Check your connection and reload.</Trans>
            </p>
          ) : null}
          <Button variant="secondary" size="small" disabled={current.isFetching} onClick={reload}>
            {current.isFetching ? t`Reloading…` : t`Reload`}
          </Button>
        </div>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          <Trans>
            Someone else changed this contact while you had it open, so your change wasn't saved.
            The latest is shown here: make your change again.
          </Trans>
        </p>
      )}
      {contact === undefined || preferences === undefined ? null : (
        <Settings
          contactId={contactId}
          preferences={preferences}
          canManage={contact.canManage && !readOnly}
          locked={outdated}
          onEdit={() => {
            setRefusedAt(undefined);
          }}
          onOutdated={() => {
            setRefusedAt(current.dataUpdatedAt);
            reload();
          }}
        />
      )}
    </ContactPanel>
  );
}

function Settings({
  contactId,
  preferences,
  canManage,
  locked,
  onEdit,
  onOutdated,
}: {
  readonly contactId: string;
  readonly preferences: Preferences;
  readonly canManage: boolean;
  /** The shown settings are known to be out of date, so no change may start from them. */
  readonly locked: boolean;
  readonly onEdit: () => void;
  readonly onOutdated: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const [editing, setEditing] = useState<Setting>();
  const [notice, setNotice] = useState<string>();
  // The button of the setting just changed, so the keyboard stays where it was.
  const focusNextRef = useRef<Setting>(undefined);
  const focusIf = (setting: Setting) => (element: HTMLElement | null) => {
    if (element !== null && focusNextRef.current === setting) {
      focusNextRef.current = undefined;
      element.focus();
    }
  };
  const open = (setting: Setting) => {
    setNotice(undefined);
    onEdit();
    setEditing(setting);
  };
  const close = (setting: Setting, saved?: string) => {
    focusNextRef.current = setting;
    setEditing(undefined);
    setNotice(saved);
  };
  const outdated = () => {
    setEditing(undefined);
    setNotice(undefined);
    onOutdated();
  };
  // Offsets are as of when the panel opened; a zone's offset changes twice a year at most.
  const [now] = useState(() => new Date());
  const zone =
    preferences.timeZone === null
      ? undefined
      : zoneOption({ name: preferences.timeZone, aliases: [] }, i18n.locale, now);
  return (
    <>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <h3 className="text-md font-semibold">
          <Trans>Time zone</Trans>
        </h3>
        {zone === undefined ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            <Trans>
              This contact has no time zone. Quiet hours follow the business's time zone.
            </Trans>
          </p>
        ) : (
          <>
            <p className="break-words">{zone.label}</p>
            {zone.detail === undefined ? null : (
              <p className="text-sm text-muted-foreground break-words">{zone.detail}</p>
            )}
            <p className="text-sm leading-relaxed text-muted-foreground">
              <Trans>Quiet hours follow the clock there.</Trans>
            </p>
          </>
        )}
        {!canManage ? null : editing === 'timeZone' ? (
          <ContactPreferenceForm
            setting="timeZone"
            contactId={contactId}
            opened={preferences}
            onOutdated={outdated}
            close={(saved) => {
              close(
                'timeZone',
                saved === undefined
                  ? undefined
                  : saved === null
                    ? t`Time zone removed.`
                    : t`Time zone saved.`,
              );
            }}
          />
        ) : (
          <Button
            ref={focusIf('timeZone')}
            variant="secondary"
            size="small"
            disabled={locked}
            onClick={() => {
              open('timeZone');
            }}
          >
            {preferences.timeZone === null ? (
              <Trans>Set time zone</Trans>
            ) : (
              <Trans>Change time zone</Trans>
            )}
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <h3 className="text-md font-semibold">
          <Trans>Do not contact</Trans>
        </h3>
        <Badge variant={preferences.doNotContact ? 'attention' : 'neutral'}>
          {preferences.doNotContact ? <Trans>On</Trans> : <Trans>Off</Trans>}
        </Badge>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {preferences.doNotContact ? (
            <Trans>
              No messages are sent to this contact, on any channel, whatever consent is recorded.
            </Trans>
          ) : (
            <Trans>Messages are sent to this contact where their consent allows it.</Trans>
          )}
        </p>
        {!canManage ? null : editing === 'doNotContact' ? (
          <ContactPreferenceForm
            setting="doNotContact"
            contactId={contactId}
            opened={preferences}
            onOutdated={outdated}
            close={(saved) => {
              close(
                'doNotContact',
                saved === undefined
                  ? undefined
                  : saved
                    ? t`Do not contact is on.`
                    : t`Do not contact is off.`,
              );
            }}
          />
        ) : (
          <Button
            ref={focusIf('doNotContact')}
            variant="secondary"
            size="small"
            disabled={locked}
            onClick={() => {
              open('doNotContact');
            }}
          >
            {preferences.doNotContact ? (
              <Trans>Turn off do not contact</Trans>
            ) : (
              <Trans>Turn on do not contact</Trans>
            )}
          </Button>
        )}
      </div>
      <p role="status" className="text-sm empty:sr-only">
        {notice}
      </p>
    </>
  );
}
