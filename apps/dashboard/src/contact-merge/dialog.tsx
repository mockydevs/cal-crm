// Merge Contacts, as GoHighLevel has it: two to ten contacts become one. The person picks the
// master contact, then, field by field, which contact's value it keeps where they differ, and
// its primary email address and phone number; the dialog says what moves to it and refuses a
// merge too large to run. It cannot be undone, so a box says so and must be ticked. The
// others go to the trash, never to come back, and the master's page opens.
// https://help.gohighlevel.com/support/solutions/articles/48001202210
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContact,
  getContactDetails,
  getRecordFields,
  mergeContacts,
  previewContactMerge,
  type Contact,
  type ContactDetails,
  type ContactMergeChoiceField,
  type MergeContactsInput,
  type RecordFields,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode, type RefObject } from 'react';

import { apiIn } from '../api';
import { contactDetailsKey } from '../contact-details-data';
import { contactKey } from '../contacts';
import { useValueLabel } from '../field-value-label';
import { returnTo } from '../list-table';
import { useBusiness } from '../workspace';
import { noteMerge } from './notice';
import {
  addressChoice,
  blockerOf,
  conflicts,
  defaultSource,
  mergeBodyOf,
  mergeOrder,
  movedRows,
  rowKey,
  type FieldRow,
} from './rules';

export interface MergeDialogProps {
  /** The contacts to merge, two to ten: the first is the master until another is picked. */
  readonly contactIds: readonly string[];
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

/** One contact as the dialog reads it: the contact, its details and its custom fields. */
interface Read {
  readonly contact: Contact;
  readonly details: ContactDetails;
  readonly fields: RecordFields;
}

/** A row of the table: the field, its label, and each contact's value in words. */
interface ShownRow {
  readonly row: FieldRow;
  readonly label: string;
  readonly texts: ReadonlyMap<string, string | null>;
}

/** A value to compare and the words it reads as. */
interface Value {
  readonly key: string;
  readonly text: string;
}

const textValue = (value: string | null | undefined): Value | null =>
  value === null || value === undefined || value.trim() === '' ? null : { key: value, text: value };

function useRows(order: readonly string[], reads: ReadonlyMap<string, Read>): ShownRow[] {
  const { t, i18n } = useLingui();
  const valueLabel = useValueLabel();
  const days = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const own: readonly {
    readonly field: ContactMergeChoiceField;
    readonly label: string;
    readonly value: (read: Read) => Value | null;
  }[] = [
    {
      field: 'firstName',
      label: t`First name`,
      value: (read) => textValue(read.contact.firstName),
    },
    { field: 'lastName', label: t`Last name`, value: (read) => textValue(read.contact.lastName) },
    {
      field: 'dateOfBirth',
      label: t`Date of birth`,
      value: ({ contact }) =>
        contact.dateOfBirth === null || contact.dateOfBirth === undefined
          ? null
          : {
              key: contact.dateOfBirth,
              // A date alone is read as midnight UTC, and shown in UTC: the day itself.
              text: days.format(new Date(contact.dateOfBirth)),
            },
    },
    { field: 'source', label: t`Contact source`, value: (read) => textValue(read.contact.source) },
    {
      field: 'type',
      label: t`Contact type`,
      value: ({ contact }) =>
        contact.type === null || contact.type === undefined
          ? null
          : { key: contact.type, text: contact.type === 'lead' ? t`Lead` : t`Customer` },
    },
    { field: 'timeZone', label: t`Time zone`, value: (read) => textValue(read.contact.timeZone) },
    {
      field: 'owner',
      label: t`Owner`,
      value: ({ details }) =>
        details.owner === null
          ? null
          : {
              key: details.owner.membershipId ?? `name:${details.owner.name ?? ''}`,
              text: details.owner.name ?? t`Former team member`,
            },
    },
  ];
  const rows: ShownRow[] = [];
  const add = (
    field: string,
    custom: boolean,
    label: string,
    value: (read: Read) => Value | null,
  ) => {
    const values = new Map<string, string | null>();
    const texts = new Map<string, string | null>();
    for (const id of order) {
      const read = reads.get(id);
      const each = read === undefined ? null : value(read);
      values.set(id, each?.key ?? null);
      texts.set(id, each?.text ?? null);
    }
    // A field none of them has a value in has nothing to merge.
    if ([...values.values()].some((each) => each !== null))
      rows.push({ row: { field, custom, values }, label, texts });
  };
  for (const each of own) add(each.field, false, each.label, each.value);
  // Every custom field any of them has, in the order the first contact holding it lists it.
  const definitions = new Map<string, RecordFields['items'][number]['definition']>();
  for (const id of order)
    for (const field of reads.get(id)?.fields.items ?? [])
      if (!definitions.has(field.definition.key))
        definitions.set(field.definition.key, field.definition);
  for (const [key, definition] of definitions)
    add(key, true, definition.label, (read) => {
      const field = read.fields.items.find((each) => each.definition.key === key);
      if (field?.value === undefined || field.value === null) return null;
      return { key: JSON.stringify(field.value), text: valueLabel(field) };
    });
  return rows;
}

/** Two dashes to look at, and "Not set" to hear. */
function Unset(): ReactElement {
  return (
    <>
      <span aria-hidden className="text-muted-foreground">
        --
      </span>
      <span className="sr-only">
        <Trans>Not set</Trans>
      </span>
    </>
  );
}

const radioClassName = 'flex min-h-11 cursor-pointer items-start gap-2 py-1 lg:min-h-8';
const radioInputClassName = 'mt-0.5 size-4 shrink-0';

/** What each kind of row that moves is called; a kind not named here reads as its key. */
function useKindWords(): (kind: string) => string {
  const { t } = useLingui();
  const words: Readonly<Record<string, string>> = {
    identities: t`Email addresses and phone numbers`,
    tags: t`Tags`,
    links: t`Associations`,
    notes: t`Notes`,
    tasks: t`Tasks`,
    taskSeries: t`Recurring tasks`,
    timeline: t`Activity entries`,
    followers: t`Followers`,
    attributions: t`Attribution touches`,
    files: t`Files`,
    scoreChanges: t`Score changes`,
    fieldValues: t`Custom field values`,
    conversations: t`Conversations`,
    messages: t`Messages`,
    consents: t`Consent records`,
    calls: t`Calls`,
    runs: t`Workflow runs`,
    submissions: t`Form submissions`,
    appointments: t`Appointments`,
    documents: t`Invoices and documents`,
    facts: t`Facts the assistant learned`,
    webchatSessions: t`Chat sessions`,
    campaignRecipients: t`Email campaign recipients`,
    campaignTests: t`Campaign test emails`,
    triggerLinkTokens: t`Trigger links sent`,
    triggerLinkClicks: t`Trigger link clicks`,
    unsubscribeLinks: t`Unsubscribe links`,
    waits: t`Workflow waits`,
    triggerFirings: t`Date trigger records`,
    triggerEvaluations: t`Workflow trigger checks`,
    manualActions: t`Manual workflow actions`,
    extractions: t`Conversations the assistant read`,
    summaries: t`Contact summaries`,
    autonomyRules: t`Assistant permissions for the contact`,
  };
  return (kind) => {
    const known = words[kind];
    if (known !== undefined) return known;
    const spaced = kind.replace(/([a-z])([A-Z])/gu, '$1 $2').replaceAll('_', ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  };
}

/** What went wrong with a request, as a sentence. */
function useProblemWords(): (error: unknown, otherwise: string) => string {
  const { t } = useLingui();
  return (error, otherwise) => {
    if (!(error instanceof ApiError)) return otherwise;
    if (error.status === 403) return t`Only admins can merge contacts.`;
    return (
      error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
      error.problem.detail ??
      error.message
    );
  };
}

function MergeForm({ contactIds, onClose }: MergeDialogProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const id = useId();
  const api = apiIn(business.id);
  const kindWords = useKindWords();
  const problemWords = useProblemWords();
  const [master, setMaster] = useState(() => contactIds[0] ?? '');
  const [picks, setPicks] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [email, setEmail] = useState<string>();
  const [phone, setPhone] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string>();
  const order = mergeOrder(contactIds, master);
  const noRetry = (failures: number, error: unknown) =>
    !(error instanceof ApiError && error.status < 500) && failures < 2;

  const contacts = useQueries({
    queries: contactIds.map((each) => ({
      queryKey: contactKey(business.id, each),
      queryFn: () => api.request(getContact, { params: { id: each } }),
      retry: noRetry,
    })),
  });
  const details = useQueries({
    queries: contactIds.map((each) => ({
      queryKey: contactDetailsKey(business.id, each),
      queryFn: () => api.request(getContactDetails, { params: { id: each } }),
      retry: noRetry,
    })),
  });
  const fields = useQueries({
    queries: contactIds.map((each) => ({
      queryKey: ['b', business.id, 'record-fields', each],
      queryFn: () => api.request(getRecordFields, { params: { id: each } }),
      retry: noRetry,
    })),
  });
  const reads = new Map<string, Read>();
  contactIds.forEach((each, index) => {
    const contact = contacts[index]?.data;
    const detail = details[index]?.data;
    const field = fields[index]?.data;
    if (contact !== undefined && detail !== undefined && field !== undefined)
      reads.set(each, { contact, details: detail, fields: field });
  });
  const readsFailed = [...contacts, ...details, ...fields].some((query) => query.isError);
  const ready = reads.size === contactIds.length;

  // The preview is the master's: another master reads it again.
  const previewKey = ['b', business.id, 'contact-merge', ...order];
  const preview = useQuery({
    queryKey: previewKey,
    queryFn: () =>
      api.request(previewContactMerge, {
        params: { id: master },
        query: { mergeIds: order.slice(1).join(',') },
      }),
    retry: noRetry,
  });
  const current =
    preview.data?.contacts.length === order.length &&
    preview.data.contacts.every((each, index) => each.id === order[index])
      ? preview.data
      : undefined;

  const rows = useRows(order, reads);
  const emails = addressChoice(
    new Map([...reads].map(([each, read]) => [each, read.contact.emails])),
    order,
  );
  const phones = addressChoice(
    new Map([...reads].map(([each, read]) => [each, read.contact.phones.map((p) => p.number)])),
    order,
  );
  const phoneText = new Map(
    [...reads.values()].flatMap((read) => read.contact.phones.map((p) => [p.number, p.display])),
  );
  const nameOf = (each: string) => {
    const contact = reads.get(each)?.contact;
    return contact?.name ?? contact?.emails[0] ?? contact?.phones[0]?.display ?? t`Unnamed contact`;
  };
  const added = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const numbers = new Intl.NumberFormat(i18n.locale);
  const blocker = blockerOf({ preview: ready ? current : undefined, confirmed });

  const merge = useMutation({
    mutationFn: (body: MergeContactsInput) =>
      api.request(mergeContacts, { params: { id: master }, body }),
    onMutate: () => {
      setProblem(undefined);
    },
    onSuccess: async (_merged, body) => {
      noteMerge(master, { kind: 'merged', count: body.mergeIds.length });
      void navigate({
        to: '/b/$slug/contacts/$contactId',
        params: { slug: business.slug, contactId: master },
      });
      onClose();
      await Promise.all(
        [
          'contacts',
          'contact-details',
          'record-fields',
          'contact-duplicates',
          'trash',
          'activity',
        ].map((part) => cache.invalidateQueries({ queryKey: ['b', business.id, part] })),
      );
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setProblem(
          t`One of these contacts changed while you had this open. The latest is shown: check your choices and merge again.`,
        );
        await Promise.all([
          cache.invalidateQueries({ queryKey: previewKey }),
          ...contactIds.flatMap((each) => [
            cache.invalidateQueries({ queryKey: contactKey(business.id, each) }),
            cache.invalidateQueries({ queryKey: contactDetailsKey(business.id, each) }),
            cache.invalidateQueries({ queryKey: ['b', business.id, 'record-fields', each] }),
          ]),
        ]);
        return;
      }
      setProblem(
        problemWords(error, t`The contacts weren't merged. Check your connection and try again.`),
      );
    },
  });
  const pending = merge.isPending;

  const moved = current === undefined ? [] : movedRows(current.moved);
  const masterName = nameOf(master);
  const tooLarge = blocker === 'too_large' && current !== undefined;
  const rowsWords = current === undefined ? '' : numbers.format(current.rows);
  const maxWords = current === undefined ? '' : numbers.format(current.maxRows);

  const addressPicker = (
    legend: string,
    choice: ReturnType<typeof addressChoice>,
    picked: string | undefined,
    onPick: (value: string) => void,
    textOf: (value: string) => string,
  ): ReactNode =>
    choice.options.length === 0 ? null : (
      <fieldset className="flex min-w-0 flex-col gap-1" disabled={pending}>
        <legend className="pb-1 text-sm font-medium">{legend}</legend>
        {choice.options.map((value) => (
          <label key={value} className={radioClassName}>
            <input
              type="radio"
              name={`${id}-${legend}`}
              className={radioInputClassName}
              checked={(picked ?? choice.fallback) === value}
              onChange={() => {
                onPick(value);
              }}
            />
            <span className="min-w-0 wrap-anywhere">{textOf(value)}</span>
          </label>
        ))}
      </fieldset>
    );

  return (
    <>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-4">
        {readsFailed ? (
          <p role="alert" className="text-sm">
            <Trans>We couldn't load the contacts.</Trans>{' '}
            <Button
              variant="quiet"
              size="small"
              onClick={() => {
                for (const query of [...contacts, ...details, ...fields])
                  if (query.isError) void query.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </p>
        ) : !ready ? (
          <p role="status" className="text-sm">
            <Trans>Loading the contacts…</Trans>
          </p>
        ) : null}
        {ready ? (
          <>
            <fieldset className="flex min-w-0 flex-col gap-1" disabled={pending}>
              <legend className="pb-1 text-sm font-medium">
                <Trans>Master contact</Trans>
              </legend>
              <p className="pb-1 text-sm text-muted-foreground">
                <Trans>
                  The contact kept. The others' notes, tasks, conversations and the rest move to it,
                  and they go to the trash.
                </Trans>
              </p>
              {contactIds.map((each) => {
                const contact = reads.get(each)?.contact;
                const on = contact === undefined ? '' : added.format(new Date(contact.createdAt));
                return (
                  <label key={each} className={radioClassName}>
                    <input
                      type="radio"
                      name={`${id}-master`}
                      className={radioInputClassName}
                      checked={master === each}
                      onChange={() => {
                        setProblem(undefined);
                        setMaster(each);
                      }}
                    />
                    <span className="min-w-0 wrap-anywhere">
                      {nameOf(each)}{' '}
                      <span className="text-sm text-muted-foreground">
                        <Trans>· Added {on}</Trans>
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {/* Sideways scrolling on a narrow screen: a column per contact, the master first.
                It keeps its height: as a scroll box in the dialog's column it would otherwise
                shrink to nothing once the dialog's body has to scroll. */}
            <div className="shrink-0 overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-max border-collapse text-sm">
                <caption className="sr-only">
                  <Trans>Each field's value, contact by contact</Trans>
                </caption>
                <thead>
                  <tr className="border-b border-border bg-secondary/60">
                    <td className="w-36 px-3 py-2" />
                    {order.map((each) => (
                      <th key={each} scope="col" className="px-3 py-2 text-left font-medium">
                        <span className="flex flex-wrap items-center gap-2">
                          {nameOf(each)}
                          {each === master ? (
                            <Badge>
                              <Trans>Master</Trans>
                            </Badge>
                          ) : null}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ row, label, texts }) => {
                    const ask = conflicts(row);
                    const kept = picks.get(rowKey(row)) ?? defaultSource(row, order);
                    return (
                      <tr key={rowKey(row)} className="border-b border-border last:border-b-0">
                        <th scope="row" className="px-3 py-2 text-left align-top font-medium">
                          {label}
                        </th>
                        {order.map((each) => {
                          const text = texts.get(each) ?? null;
                          return (
                            <td key={each} className="max-w-64 px-3 py-2 align-top">
                              {text === null ? (
                                <Unset />
                              ) : ask ? (
                                <label className={radioClassName}>
                                  <input
                                    type="radio"
                                    name={`${id}-${rowKey(row)}`}
                                    className={radioInputClassName}
                                    checked={kept === each}
                                    disabled={pending}
                                    onChange={() => {
                                      setPicks(new Map(picks).set(rowKey(row), each));
                                    }}
                                  />
                                  <span className="min-w-0 wrap-anywhere">{text}</span>
                                </label>
                              ) : (
                                <span className="wrap-anywhere">{text}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {emails.options.length > 1 || phones.options.length > 1 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {emails.options.length > 1
                  ? addressPicker(t`Primary email`, emails, email, setEmail, (value) => value)
                  : null}
                {phones.options.length > 1
                  ? addressPicker(
                      t`Primary phone`,
                      phones,
                      phone,
                      setPhone,
                      (value) => phoneText.get(value) ?? value,
                    )
                  : null}
              </div>
            ) : null}
          </>
        ) : null}
        <section aria-labelledby={`${id}-moved`} className="flex flex-col gap-2">
          <h3 id={`${id}-moved`} className="text-md font-medium">
            <Trans>What moves to {masterName}</Trans>
          </h3>
          {preview.isError ? (
            <p role="alert" className="text-sm">
              {problemWords(preview.error, t`We couldn't read what would move.`)}{' '}
              <Button
                variant="quiet"
                size="small"
                onClick={() => {
                  void preview.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </p>
          ) : current === undefined ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Counting what moves…</Trans>
            </p>
          ) : moved.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Nothing else moves: the others have no notes, tasks or history.</Trans>
            </p>
          ) : (
            <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {moved.map((each) => (
                <li key={`${each.module}:${each.kind}`}>
                  {kindWords(each.kind)}: {numbers.format(each.count)}
                </li>
              ))}
            </ul>
          )}
          {tooLarge ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              <Trans>
                These contacts have {rowsWords} rows of history between them, more than the{' '}
                {maxWords} one merge moves. Merge fewer contacts at a time.
              </Trans>
            </p>
          ) : null}
        </section>
      </div>
      <div className="flex flex-col gap-3 border-t px-4 py-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-md lg:min-h-9">
          <input
            type="checkbox"
            className="size-4 shrink-0"
            checked={confirmed}
            disabled={pending}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
          />
          <Trans>I understand this cannot be undone</Trans>
        </label>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={blocker !== undefined || pending}
            onClick={() => {
              if (current === undefined || blocker !== undefined) return;
              merge.mutate(
                mergeBodyOf({
                  order,
                  rows: rows.map((each) => each.row),
                  picks,
                  emails,
                  email,
                  phones,
                  phone,
                  preview: current,
                }),
              );
            }}
          >
            {pending ? <Trans>Merging…</Trans> : <Trans>Merge</Trans>}
          </Button>
        </div>
      </div>
    </>
  );
}

export default function MergeDialog(props: MergeDialogProps): ReactElement {
  const { t } = useLingui();
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup
          finalFocus={returnTo(props.returnFocus)}
          className="fixed inset-x-4 top-[max(16px,5dvh)] z-60 mx-auto flex max-h-[90dvh] max-w-[960px] flex-col rounded-card bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-lg font-medium">
                <Trans>Merge Contacts</Trans>
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                <Trans>
                  Pick the master contact and, where the contacts differ, the values it keeps.
                </Trans>
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <MergeForm {...props} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
