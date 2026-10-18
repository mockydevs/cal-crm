// "Add Contact": the panel that slides in from the right over the contacts list. It holds
// what the server keeps of a new contact: names, email addresses and phone numbers with a
// primary of each, a label on a phone number, the time zone, and do not disturb for every
// channel or for email and text messages. There is no contact image, contact type or
// "Customize form": nothing on the server holds them. The contact is created first; labels,
// the time zone and do not disturb are then set on it, and the page says so if one of those
// did not save. Fetched when it first opens.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  contactPhoneLabels,
  createContact,
  createContactInput,
  getContactDetails,
  offeredDndChannels,
  restoreContact,
  setContactDnd,
  updateContact,
  updateContactAddress,
  type Contact,
  type ContactDetails,
  type ContactPhoneLabel,
  type DndChannel,
  type OfferedDndChannel,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Trash2, X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';

import { apiIn } from './api';
import {
  bodyOf,
  dndOf,
  emailRow,
  emptyAddDraft,
  isReadyToAdd,
  labelsOf,
  phoneRow,
  reasonIsValid,
  sentRows,
  takenLabels,
  type AddDraft,
} from './contact-add-rules';
import { preferencesOf, REASON_MAX, REASON_MIN } from './contact-preferences-rules';
import { ContactIssueText, contactTitle, issuesByKey, type ContactIssue } from './contacts';
import { sidePanelBodyClassName } from './list-toolbar';
import { iconButtonClassName, returnTo } from './list-table';
import { useBusiness } from './workspace';

const TimeZone = lazy(() => import('./contact-add-time-zone'));

const MAX_ROWS = 10;
const NO_LABEL = 'none';
const checkboxClassName = 'size-4 shrink-0 accent-primary';
const checkLabelClassName = 'flex min-h-11 items-center gap-2.5 text-sm lg:min-h-8';
const addRowClassName = 'self-start px-1.5 font-medium text-link';

/** What of a new contact could not be set after it was created. */
export type AddedPart = 'timeZone' | 'labels' | 'dnd';

export interface AddedContact {
  readonly contact: Contact;
  /** What did not save: the contact exists without it. */
  readonly missing: readonly AddedPart[];
}

/** Creates the contact, then sets on it what creating one does not take. */
async function addContact(client: Client, draft: AddDraft): Promise<AddedContact> {
  const contact = await client.request(createContact, { body: bodyOf(draft) });
  const params = { id: contact.id };
  const missing: AddedPart[] = [];
  const preferences = preferencesOf(contact);
  if (draft.timeZone !== null) {
    try {
      if (preferences === undefined) throw new Error('The contact came without its settings.');
      await client.request(updateContact, {
        params,
        body: { timeZone: draft.timeZone, preferencesRevision: preferences.preferencesRevision },
      });
    } catch {
      missing.push('timeZone');
    }
  }
  const labels = labelsOf(draft);
  const dnd = dndOf(draft);
  if (labels.length === 0 && dnd === undefined) return { contact, missing };
  let details: ContactDetails;
  try {
    details = await client.request(getContactDetails, { params });
  } catch {
    if (labels.length > 0) missing.push('labels');
    if (dnd !== undefined) missing.push('dnd');
    return { contact, missing };
  }
  try {
    for (const { index, label } of labels) {
      // The contact answers its numbers in the order they were sent, each in E.164.
      const number = contact.phones[index]?.number;
      const address = details.addresses.find(
        (each) => each.kind === 'phone' && each.value === number,
      );
      if (address === undefined) throw new Error('The number is not among the addresses.');
      details = await client.request(updateContactAddress, {
        params: { ...params, addressId: address.id },
        body: { label, revision: details.addressesRevision },
      });
    }
  } catch {
    missing.push('labels');
  }
  if (dnd !== undefined) {
    try {
      await client.request(setContactDnd, {
        params,
        body: { ...dnd, revision: details.dnd.revision },
      });
    } catch {
      missing.push('dnd');
    }
  }
  return { contact, missing };
}

export default function AddContactPanel({
  returnFocus,
  onClose,
  onAdded,
}: {
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /** A contact was added; `another` is true when the panel stays open for the next one. */
  readonly onAdded: (added: AddedContact, another: boolean) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const navigate = useNavigate();
  const client = apiIn(business.id);
  const id = useId();
  const [draft, setDraft] = useState(emptyAddDraft);
  const [touched, setTouched] = useState(false);
  const [issues, setIssues] = useState<Record<string, ContactIssue>>({});
  const [busy, setBusy] = useState(false);
  const [addedName, setAddedName] = useState<string>();
  const firstNameRef = useRef<HTMLInputElement>(null);
  // After "Save and add another" the keyboard goes back to the first field, once the form
  // is no longer disabled by the save.
  const focusFirstRef = useRef(false);
  useEffect(() => {
    if (busy || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    firstNameRef.current?.focus();
  }, [busy]);
  const change = (next: Partial<AddDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const labelNames: Readonly<Record<ContactPhoneLabel, string>> = {
    home: t`Home`,
    work: t`Work`,
    mobile: t`Mobile`,
    landline: t`Landline`,
  };
  const channelNames: Readonly<Record<OfferedDndChannel, string>> = {
    email: t`Email`,
    sms: t`Text messages`,
    call: t`Calls & Voicemails`,
    webchat: t`Web chat`,
  };

  const ready = isReadyToAdd(draft);
  const dndOn = draft.dndAll || draft.dndChannels.length > 0;
  const firstNameMissing = touched && draft.firstName.trim() === '';

  const submit = async (another: boolean) => {
    setTouched(true);
    if (!ready || busy) return;
    const sent = sentRows(draft);
    const checked = createContactInput.safeParse(bodyOf(draft));
    if (!checked.success) {
      setIssues(
        issuesByKey(
          checked.error.issues.map((issue) => ({
            path: `/${issue.path.map(String).join('/')}`.replace(/^\/$/, ''),
            code: issue.code,
            message: issue.message,
          })),
          sent,
        ),
      );
      return;
    }
    setIssues({});
    setAddedName(undefined);
    setBusy(true);
    try {
      const added = await addContact(client, draft);
      onAdded(added, another);
      if (another) {
        setAddedName(contactTitle(added.contact) ?? t`The contact`);
        setDraft(emptyAddDraft());
        setTouched(false);
        focusFirstRef.current = true;
      }
    } catch (error) {
      setIssues(
        error instanceof ApiError && error.problem.errors !== undefined
          ? issuesByKey(error.problem.errors, sent)
          : {
              '': {
                path: '',
                code: 'not_saved',
                message:
                  error instanceof ApiError
                    ? error.message
                    : t`The contact wasn't saved. Check your connection and try again.`,
              },
            },
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async (contactId: string) => {
    setBusy(true);
    try {
      await client.request(restoreContact, { params: { id: contactId } });
      await navigate({
        to: '/b/$slug/contacts/$contactId',
        params: { slug: business.slug, contactId },
      });
    } catch (error) {
      setIssues({
        '': {
          path: '',
          code: 'not_restored',
          message:
            error instanceof ApiError
              ? error.message
              : t`The contact wasn't restored. Check your connection and try again.`,
        },
      });
      setBusy(false);
    }
  };
  const issueText = (issue: ContactIssue | undefined) => (
    <ContactIssueText
      issue={issue}
      onRestore={(contactId) => {
        void restore(contactId);
      }}
    />
  );

  const removeEmail = (key: string) => {
    const rest = draft.emails.filter((row) => row.key !== key);
    const emails = rest.length === 0 ? [emailRow()] : rest;
    change({
      emails,
      primaryEmail: emails.some((row) => row.key === draft.primaryEmail)
        ? draft.primaryEmail
        : (emails[0]?.key ?? ''),
    });
  };
  const removePhone = (key: string) => {
    const rest = draft.phones.filter((row) => row.key !== key);
    const phones = rest.length === 0 ? [phoneRow()] : rest;
    change({
      phones,
      primaryPhone: phones.some((row) => row.key === draft.primaryPhone)
        ? draft.primaryPhone
        : (phones[0]?.key ?? ''),
    });
  };
  const toggleChannel = (channel: DndChannel, on: boolean) => {
    change({
      dndChannels: on
        ? [...draft.dndChannels, channel]
        : draft.dndChannels.filter((each) => each !== channel),
    });
  };

  const formIssue = issues[''];
  const listIssues = [issues['emails'], issues['phones']].filter((issue) => issue !== undefined);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          initialFocus={firstNameRef}
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-y-0 right-0 z-60 flex w-[min(440px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3">
            <Dialog.Title className="text-base font-medium">
              <Trans>Add Contact</Trans>
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            <fieldset disabled={busy} className={`${sidePanelBodyClassName} min-w-0 border-0`}>
              <legend className="sr-only">
                <Trans>Contact details</Trans>
              </legend>
              <Field invalid={firstNameMissing || issues['firstName'] !== undefined}>
                {/* The star is drawn, not written: the field's name stays "First name". */}
                <FieldLabel className="after:ml-1 after:text-destructive after:content-['*']">
                  <Trans>First name</Trans>
                </FieldLabel>
                <Input
                  ref={firstNameRef}
                  required
                  autoComplete="off"
                  maxLength={200}
                  placeholder={t`First name`}
                  value={draft.firstName}
                  onChange={(event) => {
                    change({ firstName: event.target.value });
                  }}
                  onBlur={() => {
                    setTouched(true);
                  }}
                />
                {/* The line is kept for the message, so the form below doesn't move under a
                    pointer already on its way to another field when this one is left. */}
                <div className="min-h-5">
                  {firstNameMissing ? (
                    <FieldError match>
                      <Trans>This field is required</Trans>
                    </FieldError>
                  ) : issues['firstName'] === undefined ? null : (
                    <FieldError match>{issues['firstName'].message}</FieldError>
                  )}
                </div>
              </Field>
              <Field invalid={issues['lastName'] !== undefined}>
                <FieldLabel>
                  <Trans>Last name</Trans>
                </FieldLabel>
                <Input
                  autoComplete="off"
                  maxLength={200}
                  placeholder={t`Last name`}
                  value={draft.lastName}
                  onChange={(event) => {
                    change({ lastName: event.target.value });
                  }}
                />
                {issues['lastName'] === undefined ? null : (
                  <FieldError match>{issues['lastName'].message}</FieldError>
                )}
              </Field>
              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-1.5 text-sm font-medium">
                  <Trans>Email</Trans>
                </legend>
                {draft.emails.map((row, index) => {
                  const number = index + 1;
                  const issue = issues[row.key];
                  return (
                    <Field key={row.key} invalid={issue !== undefined} className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <input
                          type="radio"
                          name={`${id}-primary-email`}
                          className={checkboxClassName}
                          aria-label={t`Email ${number} is the primary`}
                          title={t`Primary`}
                          checked={draft.primaryEmail === row.key}
                          onChange={() => {
                            change({ primaryEmail: row.key });
                          }}
                        />
                        <Input
                          type="email"
                          autoComplete="off"
                          maxLength={320}
                          aria-label={t`Email ${number}`}
                          placeholder={t`Email`}
                          value={row.value}
                          onChange={(event) => {
                            const value = event.target.value;
                            change({
                              emails: draft.emails.map((each) =>
                                each.key === row.key ? { ...each, value } : each,
                              ),
                            });
                          }}
                        />
                        <button
                          type="button"
                          aria-label={t`Remove email ${number}`}
                          className={`${iconButtonClassName} lg:size-9`}
                          onClick={() => {
                            removeEmail(row.key);
                          }}
                        >
                          <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                        </button>
                      </div>
                      {issueText(issue)}
                    </Field>
                  );
                })}
                <Button
                  variant="quiet"
                  size="small"
                  className={addRowClassName}
                  disabled={draft.emails.length >= MAX_ROWS}
                  onClick={() => {
                    change({ emails: [...draft.emails, emailRow()] });
                  }}
                >
                  <Plus aria-hidden className="size-4" strokeWidth={2} />
                  <Trans>Add email</Trans>
                </Button>
              </fieldset>
              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-1.5 text-sm font-medium">
                  <Trans>Phone</Trans>
                </legend>
                {draft.phones.map((row, index) => {
                  const number = index + 1;
                  const issue = issues[row.key];
                  const taken = takenLabels(draft, row.key);
                  return (
                    <Field key={row.key} invalid={issue !== undefined} className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <input
                          type="radio"
                          name={`${id}-primary-phone`}
                          className={checkboxClassName}
                          aria-label={t`Phone ${number} is the primary`}
                          title={t`Primary`}
                          checked={draft.primaryPhone === row.key}
                          onChange={() => {
                            change({ primaryPhone: row.key });
                          }}
                        />
                        <Select
                          aria-label={t`Label for phone ${number}`}
                          className="w-28 shrink-0"
                          value={row.label ?? NO_LABEL}
                          onValueChange={(next) => {
                            const label = contactPhoneLabels.find((each) => each === next) ?? null;
                            change({
                              phones: draft.phones.map((each) =>
                                each.key === row.key ? { ...each, label } : each,
                              ),
                            });
                          }}
                        >
                          <option value={NO_LABEL}>{t`Select`}</option>
                          {contactPhoneLabels.map((label) => (
                            <option key={label} value={label} disabled={taken.includes(label)}>
                              {labelNames[label]}
                            </option>
                          ))}
                        </Select>
                        <Input
                          type="tel"
                          autoComplete="off"
                          maxLength={40}
                          className="min-w-0 flex-1 basis-32"
                          aria-label={t`Phone ${number}`}
                          placeholder={t`Phone`}
                          value={row.value}
                          onChange={(event) => {
                            const value = event.target.value;
                            change({
                              phones: draft.phones.map((each) =>
                                each.key === row.key ? { ...each, value } : each,
                              ),
                            });
                          }}
                        />
                        <button
                          type="button"
                          aria-label={t`Remove phone ${number}`}
                          className={`${iconButtonClassName} lg:size-9`}
                          onClick={() => {
                            removePhone(row.key);
                          }}
                        >
                          <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                        </button>
                      </div>
                      {issueText(issue)}
                    </Field>
                  );
                })}
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Write a number with + and the country code, or as it's written in the business's
                    country.
                  </Trans>
                </p>
                <Button
                  variant="quiet"
                  size="small"
                  className={addRowClassName}
                  disabled={draft.phones.length >= MAX_ROWS}
                  onClick={() => {
                    change({ phones: [...draft.phones, phoneRow()] });
                  }}
                >
                  <Plus aria-hidden className="size-4" strokeWidth={2} />
                  <Trans>Add phone</Trans>
                </Button>
              </fieldset>
              <Suspense
                fallback={
                  <p role="status" className="text-sm text-muted-foreground">
                    <Trans>Loading time zones…</Trans>
                  </p>
                }
              >
                <TimeZone
                  value={draft.timeZone}
                  disabled={busy}
                  onChange={(timeZone) => {
                    change({ timeZone });
                  }}
                />
              </Suspense>
              <fieldset className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-3">
                <legend className="sr-only">
                  <Trans>Do not disturb</Trans>
                </legend>
                <label className={checkLabelClassName}>
                  <input
                    type="checkbox"
                    className={checkboxClassName}
                    checked={draft.dndAll}
                    onChange={(event) => {
                      change({ dndAll: event.target.checked });
                    }}
                  />
                  <Trans>DND all channels</Trans>
                </label>
                <p className="flex items-center gap-3 text-xs font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                  <Trans>OR</Trans>
                </p>
                <p className="text-sm font-medium">
                  <Trans>Channels</Trans>
                </p>
                {offeredDndChannels.map((channel) => (
                  <label key={channel} className={checkLabelClassName}>
                    <input
                      type="checkbox"
                      className={checkboxClassName}
                      disabled={draft.dndAll}
                      checked={draft.dndAll || draft.dndChannels.includes(channel)}
                      onChange={(event) => {
                        toggleChannel(channel, event.target.checked);
                      }}
                    />
                    {channelNames[channel]}
                  </label>
                ))}
                {dndOn ? (
                  <Field
                    invalid={touched && !reasonIsValid(draft.dndReason)}
                    className="mt-2 min-w-0"
                  >
                    <FieldLabel>
                      <Trans>Reason</Trans>
                    </FieldLabel>
                    <Textarea
                      rows={2}
                      required
                      maxLength={REASON_MAX}
                      value={draft.dndReason}
                      onChange={(event) => {
                        change({ dndReason: event.target.value });
                      }}
                    />
                    <FieldDescription>
                      <Trans>
                        Say why, in at least {REASON_MIN} characters. It is kept with the change.
                      </Trans>
                    </FieldDescription>
                  </Field>
                ) : null}
              </fieldset>
              {listIssues.map((issue) => (
                <p key={issue.path} role="alert" className="text-sm font-medium text-destructive">
                  {issue.message}
                </p>
              ))}
              {formIssue === undefined ? null : (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {formIssue.message}
                </p>
              )}
            </fieldset>
            <p role="status" className="px-4 text-sm empty:sr-only">
              {busy ? t`Saving…` : addedName === undefined ? '' : t`${addedName} added.`}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
              <Button
                variant="secondary"
                className="mr-auto"
                disabled={busy || !ready}
                onClick={() => {
                  void submit(true);
                }}
              >
                <Trans>Save and add another</Trans>
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  onClose();
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" disabled={busy || !ready}>
                <Trans>Save</Trans>
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
