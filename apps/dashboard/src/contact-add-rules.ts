// What the Add Contact panel works out before it sends anything. A contact is created from
// its names, email addresses and phone numbers, the first of each kind being the primary;
// phone labels, the time zone and do not disturb are set on the new contact afterwards,
// each by its own endpoint.
import {
  DO_NOT_CONTACT_REASON_MAX,
  DO_NOT_CONTACT_REASON_MIN,
  dndChannelsOf,
  type ContactPhoneLabel,
  type DndChannel,
} from '@repo/contracts';

export interface EmailRow {
  readonly key: string;
  readonly value: string;
}

export interface PhoneRow extends EmailRow {
  readonly label: ContactPhoneLabel | null;
}

export interface AddDraft {
  readonly firstName: string;
  readonly lastName: string;
  readonly emails: readonly EmailRow[];
  /** The key of the row that is the primary address. */
  readonly primaryEmail: string;
  readonly phones: readonly PhoneRow[];
  readonly primaryPhone: string;
  readonly timeZone: string | null;
  readonly dndAll: boolean;
  readonly dndChannels: readonly DndChannel[];
  readonly dndReason: string;
}

export const emailRow = (): EmailRow => ({ key: crypto.randomUUID(), value: '' });
export const phoneRow = (): PhoneRow => ({ key: crypto.randomUUID(), value: '', label: null });

export function emptyAddDraft(): AddDraft {
  const email = emailRow();
  const phone = phoneRow();
  return {
    firstName: '',
    lastName: '',
    emails: [email],
    primaryEmail: email.key,
    phones: [phone],
    primaryPhone: phone.key,
    timeZone: null,
    dndAll: false,
    dndChannels: [],
    dndReason: '',
  };
}

/** The rows with something in them, the primary one first, then the others in order. */
function sent<Row extends EmailRow>(rows: readonly Row[], primary: string): Row[] {
  const filled = rows.filter((row) => row.value.trim() !== '');
  return [
    ...filled.filter((row) => row.key === primary),
    ...filled.filter((row) => row.key !== primary),
  ];
}

export interface AddBody {
  readonly firstName: string;
  readonly lastName: string;
  readonly emails: string[];
  readonly phones: string[];
}

export function bodyOf(draft: AddDraft): AddBody {
  return {
    firstName: draft.firstName,
    lastName: draft.lastName,
    emails: sent(draft.emails, draft.primaryEmail).map((row) => row.value),
    phones: sent(draft.phones, draft.primaryPhone).map((row) => row.value),
  };
}

/** The rows as they were sent, so an issue about one is shown on its row. */
export function sentRows(draft: AddDraft): { emails: EmailRow[]; phones: PhoneRow[] } {
  return {
    emails: sent(draft.emails, draft.primaryEmail),
    phones: sent(draft.phones, draft.primaryPhone),
  };
}

/** Each label to set once the contact exists, by the place of its number in what was sent. */
export function labelsOf(
  draft: AddDraft,
): { readonly index: number; readonly label: ContactPhoneLabel }[] {
  return sent(draft.phones, draft.primaryPhone).flatMap((row, index) =>
    row.label === null ? [] : [{ index, label: row.label }],
  );
}

/** The labels other rows have taken: a contact uses each label once. */
export function takenLabels(draft: AddDraft, key: string): ContactPhoneLabel[] {
  return draft.phones.flatMap((row) => (row.key === key || row.label === null ? [] : [row.label]));
}

const wantsDnd = (draft: AddDraft): boolean => draft.dndAll || draft.dndChannels.length > 0;

/** Do not disturb as the server takes it, or nothing when no switch is on. */
export function dndOf(
  draft: AddDraft,
): { readonly all: boolean; readonly channels: DndChannel[]; readonly reason: string } | undefined {
  if (!wantsDnd(draft)) return undefined;
  return {
    all: draft.dndAll,
    // "All channels" stands for each of them; none is named beside it.
    channels: draft.dndAll ? [] : dndChannelsOf(draft.dndChannels),
    reason: draft.dndReason.trim(),
  };
}

export function reasonIsValid(reason: string): boolean {
  const length = reason.trim().length;
  return length >= DO_NOT_CONTACT_REASON_MIN && length <= DO_NOT_CONTACT_REASON_MAX;
}

/** Whether Save is offered: a first name, and why when do not disturb is switched on. */
export function isReadyToAdd(draft: AddDraft): boolean {
  return draft.firstName.trim() !== '' && (!wantsDnd(draft) || reasonIsValid(draft.dndReason));
}
