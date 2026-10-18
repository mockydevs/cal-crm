// The two forms of the contact's time zone and do-not-contact panel, fetched the first
// time someone changes either: the picker brings Base UI's combobox, which the contact
// page shouldn't wait for.
import { Trans, useLingui } from '@lingui/react/macro';
import { listTimeZones, updateContact, type UpdateContactInput } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Combobox } from '@repo/ui/components/combobox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  doNotContactChange,
  REASON_MAX,
  REASON_MIN,
  timeZoneChange,
  zoneChoices,
  zoneMatches,
  zoneOption,
  type ContactPreferences as Preferences,
  type DoNotContactProblem,
  type PreferenceChange,
} from './contact-preferences-rules';
import { contactKey } from './contacts';
import { noRejection, rejection, type Rejection } from './problems';
import { useBusiness } from './workspace';

export type ContactPreferenceFormProps =
  | ({ readonly setting: 'timeZone' } & TimeZoneFormProps)
  | ({ readonly setting: 'doNotContact' } & DoNotContactFormProps);

/** The form for one of the two settings. */
export default function ContactPreferenceForm(props: ContactPreferenceFormProps): ReactElement {
  return props.setting === 'timeZone' ? (
    <TimeZoneForm {...props} />
  ) : (
    <DoNotContactForm {...props} />
  );
}

/**
 * Saves a change to the settings through the contact's own endpoint. The answer is the
 * contact, which replaces the cached one; what else shows these settings is read again.
 */
function useSaveChange(
  contactId: string,
  handlers: {
    readonly onSaved: () => void;
    readonly onOutdated: () => void;
    readonly onRefused: (problem: Rejection) => void;
  },
) {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  return useMutation({
    // The contact's other fields are left out: only what is sent changes.
    mutationFn: (body: UpdateContactInput & PreferenceChange) =>
      apiIn(business.id).request(updateContact, { params: { id: contactId }, body }),
    onSuccess: async (saved) => {
      cache.setQueryData(contactKey(business.id, contactId), saved);
      handlers.onSaved();
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['b', business.id, 'consent', contactId] }),
        // Do not disturb for every channel is this same setting, read with the details.
        cache.invalidateQueries({ queryKey: ['b', business.id, 'contact-details', contactId] }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity', contactId] }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'messaging-settings'] }),
      ]);
    },
    onError: (error) => {
      // A conflict: the settings, or the contact itself, changed since the form opened.
      if (error instanceof ApiError && error.status === 409) {
        handlers.onOutdated();
        return;
      }
      const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      handlers.onRefused(
        issues.length > 0
          ? rejection(issues)
          : {
              fields: {},
              form:
                error instanceof ApiError
                  ? error.message
                  : t`The change wasn't saved. Check your connection and try again.`,
            },
      );
    },
  });
}

interface TimeZoneFormProps {
  readonly contactId: string;
  /** The settings as the form opened with them; its change names their revision. */
  readonly opened: Preferences;
  readonly onOutdated: () => void;
  /** Closes the form: with the saved zone (null for removed), or with nothing for no change. */
  readonly close: (saved?: string | null) => void;
}

function TimeZoneForm({ contactId, opened, onOutdated, close }: TimeZoneFormProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  // The form opens in place of the button that was pressed, so the keyboard moves into it:
  // into the box, once the zones have arrived.
  const focusOnMount = useCallback((box: HTMLInputElement | null) => {
    box?.focus();
  }, []);
  // What the form started from: a save elsewhere must not move the base under it.
  const [base] = useState(opened);
  const [chosen, setChosen] = useState(base.timeZone);
  const [problem, setProblem] = useState(noRejection);
  const locale = i18n.locale;
  // The zones this server takes. Its list is the rule; the browser only describes them.
  const zones = useQuery({
    queryKey: ['time-zones'],
    queryFn: () => apiIn(business.id).request(listTimeZones, {}),
    staleTime: Infinity,
  });
  const listed = zones.data?.items;
  const [now] = useState(() => new Date());
  // A few hundred zones, described once for as long as the form is open.
  const options = useMemo(
    () =>
      listed === undefined
        ? []
        : zoneChoices(listed, base.timeZone).map((choice) => zoneOption(choice, locale, now)),
    [listed, base.timeZone, locale, now],
  );
  const save = useSaveChange(contactId, {
    onSaved: () => {
      close(chosen);
    },
    onOutdated,
    onRefused: setProblem,
  });
  return (
    <Form<Record<string, unknown>>
      className="w-full min-w-0"
      errors={problem.fields}
      onFormSubmit={() => {
        const change = timeZoneChange(base, chosen);
        if (change === undefined) {
          close();
          return;
        }
        setProblem(noRejection);
        save.mutate(change);
      }}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="sr-only">
          {base.timeZone === null ? t`Set time zone` : t`Change time zone`}
        </legend>
        {zones.isPending ? <p role="status" className="text-sm">{t`Loading time zones…`}</p> : null}
        {zones.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm">
            <p>
              <Trans>The time zones couldn't be loaded.</Trans>
            </p>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => {
                void zones.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
        {listed === undefined ? null : (
          <Field name="timeZone">
            <FieldLabel>
              <Trans>Time zone</Trans>
            </FieldLabel>
            <Combobox
              ref={focusOnMount}
              options={options}
              value={chosen}
              onValueChange={setChosen}
              matches={zoneMatches}
              disabled={save.isPending}
              placeholder={t`Search by city, region or offset`}
              empty={t`No time zones match.`}
              clearLabel={t`Clear time zone`}
            />
            <FieldDescription>
              {base.timeZone === null ? (
                <Trans>Type a city, such as Nairobi, and choose from the list.</Trans>
              ) : (
                <Trans>
                  Type a city, such as Nairobi, and choose from the list. Clear the box to remove
                  the time zone.
                </Trans>
              )}
            </FieldDescription>
            <FieldError />
          </Field>
        )}
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {listed === undefined ? null : (
            <Button type="submit" size="small">
              {save.isPending ? t`Saving…` : t`Save`}
            </Button>
          )}
          <Button
            type="button"
            variant="quiet"
            size="small"
            onClick={() => {
              close();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}

interface DoNotContactFormProps {
  readonly contactId: string;
  /** The settings as the form opened with them; its change names their revision. */
  readonly opened: Preferences;
  readonly onOutdated: () => void;
  /** Closes the form: with what do not contact now is, or with nothing for no change. */
  readonly close: (saved?: boolean) => void;
}

function DoNotContactForm({
  contactId,
  opened,
  onOutdated,
  close,
}: DoNotContactFormProps): ReactElement {
  const { t } = useLingui();
  const confirmId = useId();
  const reasonRef = useRef<HTMLInputElement>(null);
  // The form opens in place of the button that was pressed, so the keyboard moves into it.
  useEffect(() => {
    reasonRef.current?.focus();
  }, []);
  // What the form started from: a save elsewhere must not move the base under it.
  const [base] = useState(opened);
  const turningOn = !base.doNotContact;
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState(noRejection);
  const save = useSaveChange(contactId, {
    onSaved: () => {
      close(turningOn);
    },
    onOutdated,
    onRefused: (refusal) => {
      setProblem(refusal);
    },
  });
  const problemText = (kind: DoNotContactProblem): string => {
    switch (kind) {
      case 'missing':
      case 'too_short':
        return t`Say why, in at least ${REASON_MIN} characters.`;
      case 'too_long':
        return t`Use at most ${REASON_MAX} characters.`;
      case 'unconfirmed':
        return turningOn
          ? t`Confirm that no messages should be sent to this contact.`
          : t`Confirm that this contact may be sent messages again.`;
    }
  };
  return (
    <Form<Record<string, unknown>>
      className="w-full min-w-0"
      errors={problem.fields}
      onFormSubmit={() => {
        const answer = doNotContactChange(base, { reason, confirmed });
        if ('problem' in answer) {
          const text = problemText(answer.problem);
          setProblem(
            answer.problem === 'unconfirmed'
              ? { fields: {}, form: text }
              : { fields: { doNotContactReason: text }, form: undefined },
          );
          return;
        }
        setProblem(noRejection);
        save.mutate(answer.change);
      }}
    >
      <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-sm font-semibold">
          {turningOn ? t`Turn on do not contact` : t`Turn off do not contact`}
        </legend>
        <Field name="doNotContactReason">
          <FieldLabel>
            <Trans>Why?</Trans>
          </FieldLabel>
          <Textarea
            rows={3}
            ref={reasonRef}
            // Not the browser's own "required": the message under the field says what to write.
            aria-required="true"
            value={reason}
            onValueChange={(value) => {
              setReason(value);
            }}
          />
          <FieldDescription>
            <Trans>
              This is kept with the change, with your name and the time. For example: asked by phone
              on 9 October not to be contacted.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <label htmlFor={confirmId} className="flex items-start gap-2 text-sm leading-relaxed">
          <input
            id={confirmId}
            type="checkbox"
            className="mt-1"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
          />
          <span>
            {turningOn ? (
              <Trans>
                I confirm that no messages should be sent to this contact, on any channel, until
                this is turned off.
              </Trans>
            ) : (
              <Trans>
                I confirm that this contact may be sent messages again, where their consent allows
                it.
              </Trans>
            )}
          </span>
        </label>
        {problem.form === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem.form}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="small">
            {save.isPending ? t`Saving…` : t`Save`}
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="small"
            onClick={() => {
              close();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </Form>
  );
}
