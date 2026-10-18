import { Trans, useLingui } from '@lingui/react/macro';
import {
  getContactCompanies,
  linkContactCompany,
  listCompanies,
  unlinkContactCompany,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { ContactPanel, PanelEmpty } from './contact-panels';
import { useBusiness } from './workspace';

type Change =
  { kind: 'link'; companyId: string; primary?: boolean } | { kind: 'remove'; companyId: string };

export function ContactCompanies({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  readonly readOnly: boolean;
}): ReactElement {
  const { t } = useLingui();
  const primaryLabel = (name: string, primary: boolean) =>
    primary ? t`Clear ${name} as primary` : t`Make ${name} primary`;
  const removeLabel = (name: string) => t`Remove ${name} company link`;
  const business = useBusiness();
  const client = apiIn(business.id);
  const cache = useQueryClient();
  const key = ['b', business.id, 'contact-companies', contactId];
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const focusNextRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (search.trim() === q) return;
    const timer = setTimeout(() => {
      setQ(search.trim());
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [search, q]);
  const linked = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request(getContactCompanies, {
        params: { id: contactId },
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const canManage = !readOnly && linked.data?.pages[0]?.canManage === true;
  const choices = useInfiniteQuery({
    queryKey: ['b', business.id, 'companies', 'list', q],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request(listCompanies, {
        query: {
          ...(q === '' ? {} : { q }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: canManage,
    // Each search is a query of its own. The companies already listed stay to choose from
    // until its answer arrives; without them the list went disabled for that moment, and
    // a click on it then did nothing.
    placeholderData: keepPreviousData,
  });
  const change = useMutation({
    mutationFn: (input: Change) =>
      input.kind === 'remove'
        ? client.request(unlinkContactCompany, {
            params: { id: contactId, companyId: input.companyId },
          })
        : client.request(linkContactCompany, {
            params: { id: contactId, companyId: input.companyId },
            body: input.primary === undefined ? {} : { primary: input.primary },
          }),
    onMutate: () => {
      setNotice(undefined);
    },
    onSuccess: async (_result, input) => {
      if (input.kind === 'remove')
        focusNextRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelected('');
      await Promise.all([
        cache.invalidateQueries({ queryKey: key }),
        cache.invalidateQueries({ queryKey: ['b', business.id, 'activity'] }),
      ]);
      setNotice(input.kind === 'remove' ? t`Company link removed.` : t`Company link saved.`);
    },
  });
  useEffect(() => {
    if (change.isPending) return;
    const previous = focusNextRef.current;
    focusNextRef.current = null;
    if (
      previous !== null &&
      (document.activeElement === previous || document.activeElement === document.body)
    )
      searchRef.current?.focus();
  }, [change.isPending]);
  const items = linked.data?.pages.flatMap((page) => page.items) ?? [];
  const options =
    choices.data?.pages
      .flatMap((page) => page.items)
      .filter((company) => !items.some((item) => item.company.id === company.id)) ?? [];
  const selectedAvailable = options.some((company) => company.id === selected);
  return (
    <ContactPanel title={t`Companies`}>
      {linked.isPending ? (
        <p role="status">
          <Trans>Loading companies…</Trans>
        </p>
      ) : null}
      {linked.isError ? (
        <div role="alert">
          <p>
            <Trans>Company links couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void linked.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {items.length === 0 && linked.isSuccess ? (
        <PanelEmpty
          icon={<Building2 />}
          title={t`No companies linked.`}
          description={
            canManage
              ? t`Find a company below to link this contact to it.`
              : t`The companies this contact belongs to show here.`
          }
        />
      ) : null}
      <ul className="flex flex-col gap-4">
        {items.map(({ company, isPrimary }) => (
          <li key={company.id} className="flex min-w-0 flex-col items-start gap-2">
            <Link
              className="break-words text-link underline"
              to="/b/$slug/contacts/companies/$companyId"
              params={{ slug: business.slug, companyId: company.id }}
            >
              {company.name}
            </Link>
            <div className="flex flex-wrap gap-2">
              {isPrimary ? (
                <Badge>
                  <Trans>Primary</Trans>
                </Badge>
              ) : null}
              {company.trashedAt !== null ? (
                <Badge>
                  <Trans>In trash</Trans>
                </Badge>
              ) : null}
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                {company.trashedAt === null ? (
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={change.isPending}
                    aria-label={primaryLabel(company.name, isPrimary)}
                    onClick={() => {
                      change.mutate({ kind: 'link', companyId: company.id, primary: !isPrimary });
                    }}
                  >
                    {isPrimary ? <Trans>Clear primary</Trans> : <Trans>Make primary</Trans>}
                  </Button>
                ) : null}
                <Button
                  variant="quiet"
                  size="small"
                  disabled={change.isPending}
                  aria-label={removeLabel(company.name)}
                  onClick={() => {
                    change.mutate({ kind: 'remove', companyId: company.id });
                  }}
                >
                  <Trans>Remove</Trans>
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {linked.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={linked.isFetching}
          onClick={() => {
            void linked.fetchNextPage();
          }}
        >
          <Trans>Load more linked companies</Trans>
        </Button>
      ) : null}
      {canManage ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedAvailable && !change.isPending)
              change.mutate({ kind: 'link', companyId: selected });
          }}
        >
          <Field name="findCompany">
            <FieldLabel>
              <Trans>Find company</Trans>
            </FieldLabel>
            <Input
              ref={searchRef}
              value={search}
              maxLength={200}
              onValueChange={(value) => {
                setSearch(value);
                setSelected('');
              }}
            />
          </Field>
          <Field name="company">
            <FieldLabel>
              <Trans>Company</Trans>
            </FieldLabel>
            <Select
              value={selected}
              onValueChange={setSelected}
              disabled={change.isPending || choices.isPending}
            >
              <option value="">{t`Choose a company`}</option>
              {options.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
          {choices.isError ? (
            <div role="alert">
              <p>
                <Trans>Available companies couldn't be loaded.</Trans>
              </p>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void choices.refetch();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : null}
          {choices.hasNextPage ? (
            <Button
              variant="secondary"
              disabled={choices.isFetching}
              onClick={() => {
                void choices.fetchNextPage();
              }}
            >
              <Trans>Load more available companies</Trans>
            </Button>
          ) : null}
          <Button type="submit" disabled={!selectedAvailable || change.isPending}>
            <Trans>Link company</Trans>
          </Button>
        </form>
      ) : null}
      {change.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {change.error instanceof ApiError
            ? change.error.message
            : t`The company link wasn't saved. Try again.`}
        </p>
      ) : null}
      {notice === undefined ? null : (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <Link
        className="text-sm text-link underline"
        to="/b/$slug/contacts/companies"
        params={{ slug: business.slug }}
      >
        <Trans>All companies</Trans>
      </Link>
    </ContactPanel>
  );
}
