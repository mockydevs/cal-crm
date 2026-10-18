// Contacts: the form that changes one, and what the contact pages share. A contact is added
// in the panel over the list (contact-add-panel.tsx). A duplicate email address or phone
// number comes back on its own row, with a link to the contact holding it, or a button to
// restore that contact from the trash.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContact,
  restoreContact,
  updateContactInput,
  type Contact,
  type Problem,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';

import { apiIn } from './api';
import { useBusiness } from './workspace';

/** Where a contact is cached: under its business, so no other business's shows. */
export function contactKey(businessId: string, id: string): readonly string[] {
  return ['b', businessId, 'contacts', id];
}

/** A contact of a business, read in that business. */
export function useContact(businessId: string, id: string): UseQueryResult<Contact> {
  return useQuery({
    queryKey: contactKey(businessId, id),
    queryFn: () => apiIn(businessId).request(getContact, { params: { id } }),
    // A contact that isn't there won't appear on a retry; other failures may pass.
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status === 404) && failures < 3,
  });
}

// Links that look like the buttons beside them (packages/ui's Button), sizes and all: a
// link navigates, so it stays a link for assistive technology.
const linkBaseClassName =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors';
export const primaryLinkClassName = `${linkBaseClassName} min-h-11 bg-primary px-3.5 text-primary-foreground shadow-[0_1px_2px_rgb(16_24_40/0.05)] hover:bg-primary-hover lg:min-h-9`;
export const secondaryLinkClassName = `${linkBaseClassName} min-h-11 border border-input bg-card px-3.5 text-foreground hover:bg-muted lg:min-h-9`;
export const quietLinkClassName = `${linkBaseClassName} min-h-10 px-3 font-normal text-muted-foreground hover:bg-muted hover:text-foreground lg:min-h-8`;

/** While a contact loads, or why it didn't. */
export function ContactLoading({
  query,
}: {
  readonly query: UseQueryResult<Contact>;
}): ReactElement | null {
  const business = useBusiness();
  if (query.isPending)
    return (
      <p role="status">
        <Trans>Loading contact…</Trans>
      </p>
    );
  if (query.error instanceof ApiError && query.error.status === 404)
    return (
      <p role="alert" className="text-md">
        <Trans>This contact doesn't exist, or it belongs to another business.</Trans>{' '}
        <Link
          to="/b/$slug/contacts"
          params={{ slug: business.slug }}
          className="text-link underline"
        >
          <Trans>Go to contacts</Trans>
        </Link>
      </p>
    );
  if (query.isError)
    return (
      <p role="alert">
        <Trans>We couldn't load the contact.</Trans>{' '}
        <Button
          variant="quiet"
          onClick={() => {
            void query.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </p>
    );
  return null;
}

export { contactTitle } from './contact-title';

export type ContactIssue = NonNullable<Problem['errors']>[number];
type Issue = ContactIssue;
type ListName = 'emails' | 'phones';

/** One entry of a list, with a key that stays with it when another is removed. */
interface Row {
  readonly key: string;
  readonly value: string;
}

const rowOf = (value: string): Row => ({ key: crypto.randomUUID(), value });

/** What the form shows to start with: a contact's details, or nothing. */
export interface ContactDraft {
  readonly firstName: string;
  readonly lastName: string;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
}

export function draftOf(contact: Contact): ContactDraft {
  return {
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    emails: contact.emails.length > 0 ? contact.emails : [''],
    phones: contact.phones.length > 0 ? contact.phones.map((phone) => phone.display) : [''],
  };
}

/** What the form sends; blank rows are left out. */
export interface ContactBody {
  readonly firstName: string;
  readonly lastName: string;
  readonly emails: string[];
  readonly phones: string[];
}

/**
 * Each issue under what it's about: a name, a row of a list (by its key), a list as a
 * whole, or the form (''). Rows are found by their place in what was sent.
 */
export function issuesByKey(
  issues: readonly Issue[],
  sent: Readonly<Record<ListName, readonly { readonly key: string }[]>>,
): Record<string, Issue> {
  const found: Record<string, Issue> = {};
  for (const issue of issues) {
    const [field = '', index] = issue.path.replace(/^\//, '').split('/');
    const row =
      (field === 'emails' || field === 'phones') && index !== undefined
        ? sent[field][Number(index)]
        : undefined;
    found[row?.key ?? field] ??= issue;
  }
  return found;
}

/** The issue about a row, with the way to the contact that already has its value. */
export function ContactIssueText({
  issue,
  onRestore,
}: {
  readonly issue: ContactIssue | undefined;
  /** Restores the contact in the trash that has the value, by its id. */
  readonly onRestore: (id: string) => void;
}): ReactElement | null {
  const business = useBusiness();
  if (issue === undefined) return null;
  const existing = issue.existing;
  const name = existing?.name ?? null;
  return (
    <FieldError match>
      {issue.message}
      {existing === undefined ? null : existing.trashed ? (
        <Button
          variant="secondary"
          size="small"
          className="mt-2 flex"
          onClick={() => {
            onRestore(existing.id);
          }}
        >
          {name === null ? <Trans>Restore that contact</Trans> : <Trans>Restore {name}</Trans>}
        </Button>
      ) : (
        <>
          {' '}
          <Link
            to="/b/$slug/contacts/$contactId"
            params={{ slug: business.slug, contactId: existing.id }}
            className="text-link underline"
          >
            {name === null ? <Trans>Open that contact</Trans> : <Trans>Open {name}</Trans>}
          </Link>
        </>
      )}
    </FieldError>
  );
}

export function ContactForm({
  initial,
  submitLabel,
  save,
  onSaved,
  cancel,
}: {
  readonly initial: ContactDraft;
  readonly submitLabel: string;
  readonly save: (body: ContactBody) => Promise<Contact>;
  readonly onSaved: (contact: Contact) => Promise<void>;
  readonly cancel: ReactElement;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [lists, setLists] = useState<Record<ListName, Row[]>>({
    emails: initial.emails.map(rowOf),
    phones: initial.phones.map(rowOf),
  });
  const [issues, setIssues] = useState<Record<string, Issue>>({});
  const [busy, setBusy] = useState(false);
  // Where the keyboard goes when a row's Remove button disappears with its row: the list's
  // Add button, once the removal has rendered (so it's enabled again at ten rows).
  const focusAddRef = useRef<ListName>(undefined);

  const change = (list: ListName, next: (rows: Row[]) => Row[]) => {
    setLists((current) => ({ ...current, [list]: next(current[list]) }));
  };

  const submit = async () => {
    const sent = {
      emails: lists.emails.filter((row) => row.value.trim() !== ''),
      phones: lists.phones.filter((row) => row.value.trim() !== ''),
    };
    const body: ContactBody = {
      firstName,
      lastName,
      emails: sent.emails.map((row) => row.value),
      phones: sent.phones.map((row) => row.value),
    };
    const checked = updateContactInput.safeParse(body);
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
    setBusy(true);
    try {
      await onSaved(await save(body));
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

  const restore = async (id: string) => {
    setBusy(true);
    try {
      const restored = await apiIn(business.id).request(restoreContact, { params: { id } });
      cache.setQueryData(contactKey(business.id, id), restored);
      await navigate({
        to: '/b/$slug/contacts/$contactId',
        params: { slug: business.slug, contactId: id },
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

  const issueAbout = (issue: Issue | undefined) => (
    <ContactIssueText
      issue={issue}
      onRestore={(id) => {
        void restore(id);
      }}
    />
  );

  const list = (name: ListName) => {
    const rows = lists[name];
    const emails = name === 'emails';
    const listIssue = issues[name];
    return (
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">
          {emails ? <Trans>Email addresses</Trans> : <Trans>Phone numbers</Trans>}
        </legend>
        <p className="text-sm text-muted-foreground">
          {emails ? (
            <Trans>The first is the primary address.</Trans>
          ) : (
            <Trans>
              The first is the primary number. Write it with + and the country code, or as it's
              written in the business's country.
            </Trans>
          )}
        </p>
        {rows.map((row, index) => {
          const number = index + 1;
          const issue = issues[row.key];
          return (
            <Field key={row.key} invalid={issue !== undefined} className="min-w-0">
              <FieldLabel className="sr-only">
                {emails ? (
                  <Trans>Email address {number}</Trans>
                ) : (
                  <Trans>Phone number {number}</Trans>
                )}
              </FieldLabel>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  type={emails ? 'email' : 'tel'}
                  autoComplete="off"
                  maxLength={emails ? 320 : 40}
                  value={row.value}
                  onChange={(event) => {
                    const value = event.target.value;
                    change(name, (current) =>
                      current.map((each) => (each.key === row.key ? { ...each, value } : each)),
                    );
                  }}
                />
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={
                    emails ? t`Remove email address ${number}` : t`Remove phone number ${number}`
                  }
                  onClick={() => {
                    focusAddRef.current = name;
                    change(name, (current) => current.filter((each) => each.key !== row.key));
                  }}
                >
                  <Trans>Remove</Trans>
                </Button>
              </div>
              {issueAbout(issue)}
            </Field>
          );
        })}
        {listIssue === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {listIssue.message}
          </p>
        )}
        <Button
          ref={(element) => {
            if (element !== null && focusAddRef.current === name) {
              focusAddRef.current = undefined;
              element.focus();
            }
          }}
          variant="secondary"
          size="small"
          className="self-start"
          disabled={rows.length >= 10}
          onClick={() => {
            change(name, (current) => [...current, rowOf('')]);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          {emails ? <Trans>Add email address</Trans> : <Trans>Add phone number</Trans>}
        </Button>
      </fieldset>
    );
  };

  const nameField = (
    field: 'firstName' | 'lastName',
    value: string,
    set: (value: string) => void,
  ) => {
    const issue = issues[field];
    return (
      <Field invalid={issue !== undefined}>
        <FieldLabel>
          {field === 'firstName' ? <Trans>First name</Trans> : <Trans>Last name</Trans>}
        </FieldLabel>
        <Input
          autoComplete="off"
          maxLength={200}
          value={value}
          onChange={(event) => {
            set(event.target.value);
          }}
        />
        {issue === undefined ? null : <FieldError match>{issue.message}</FieldError>}
      </Field>
    );
  };

  const formIssue = issues[''];
  return (
    <form
      noValidate
      className="flex flex-col gap-6 rounded-card border border-border bg-card p-[22px]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6">
        <legend className="sr-only">
          <Trans>Contact details</Trans>
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {nameField('firstName', firstName, setFirstName)}
          {nameField('lastName', lastName, setLastName)}
        </div>
        {list('emails')}
        {list('phones')}
        {formIssue === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {formIssue.message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="submit">{busy ? <Trans>Saving…</Trans> : submitLabel}</Button>
          {cancel}
        </div>
      </fieldset>
    </form>
  );
}
