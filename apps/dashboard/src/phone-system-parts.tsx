// What the Phone System page, its number editor and its calling defaults share: where their
// answers are kept, the tabs they are split into, a whole number typed into a field, and
// the words for whether calls work, a number's warnings and a refused field.
import { useLingui } from '@lingui/react/macro';
import {
  listPhoneSystemMembers,
  type PhoneCalling,
  type PhoneNumberSettings,
  type PhoneNumberWarningCode,
  type phoneSystemMemberList,
} from '@repo/contracts';
import { Input } from '@repo/ui/components/input';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type * as z from 'zod';
import { apiIn } from './api';
import type { ControlProps } from './calendar-settings-parts';
import type { Person } from './calendar-settings-rules';
import type { FieldProblem } from './phone-system-rules';
import { retryFaults } from './settings-list';

// Under ['phone-numbers', businessId] like the SMS list, so registering a number on the
// same page (sms-settings.tsx) reads the inventory again too.
export const phoneSettingsKey = (businessId: string) =>
  ['phone-system-settings', businessId] as const;
export const phoneNumbersKey = (businessId: string) =>
  ['phone-numbers', businessId, 'phone-system'] as const;
export const phoneNumberKey = (businessId: string, id: string) =>
  ['phone-numbers', businessId, 'phone-system', id] as const;

export type PhoneSystemMemberList = z.output<typeof phoneSystemMemberList>;

/** The most members one read answers (listPhoneSystemMembers' own limit). */
const MEMBERS_PER_PAGE = 100;

export interface PhoneMembers {
  /** Everyone who may own a number or take its calls, once every page is read. */
  readonly people: readonly Person[] | undefined;
  readonly isError: boolean;
  readonly retry: () => void;
}

/**
 * The people a number can be given to or ring: the business's current members, as
 * GET /phone-system/members lists them under phone.manage, so no Team permission is
 * needed and nobody disabled is offered. Every page is read before anyone is offered, so
 * a person on a later page is never taken for one who left.
 */
export function usePhoneMembers(businessId: string): PhoneMembers {
  const members = useInfiniteQuery({
    queryKey: ['b', businessId, 'phone-system-members'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(businessId).request(listPhoneSystemMembers, {
        query: { limit: MEMBERS_PER_PAGE, ...(pageParam === '' ? {} : { after: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryFaults,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage, refetch } = members;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const complete = members.data !== undefined && !hasNextPage && !isError;
  return {
    people: complete
      ? members.data.pages.flatMap((page) =>
          page.data.map((member) => ({
            membershipId: member.id,
            name: member.name,
            email: member.email,
          })),
        )
      : undefined,
    isError,
    retry: () => {
      void (hasNextPage ? fetchNextPage() : refetch());
    },
  };
}

export const personName = (person: Person): string =>
  person.name === '' ? person.email : person.name;

/** A row of tabs: the arrow keys, Home and End move between them, as WAI-ARIA's do. */
export function Tabs<Tab extends string>({
  label,
  tabs,
  current,
  idBase,
  onChange,
}: {
  readonly label: string;
  readonly tabs: readonly { readonly id: Tab; readonly label: string }[];
  readonly current: Tab;
  /** Each tab is `${idBase}-tab-${id}` and controls `${idBase}-panel-${id}`. */
  readonly idBase: string;
  readonly onChange: (tab: Tab) => void;
}): ReactElement {
  const buttonsRef = useRef(new Map<Tab, HTMLButtonElement>());
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex min-w-0 flex-wrap gap-x-1 border-b border-border"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(button) => {
            if (button === null) buttonsRef.current.delete(tab.id);
            else buttonsRef.current.set(tab.id, button);
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${tab.id}`}
          aria-selected={tab.id === current}
          aria-controls={`${idBase}-panel-${tab.id}`}
          tabIndex={tab.id === current ? 0 : -1}
          className="-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-body -outline-offset-2 hover:text-foreground aria-selected:border-primary aria-selected:text-link lg:min-h-10"
          onClick={() => {
            onChange(tab.id);
          }}
          onKeyDown={(event) => {
            const last = tabs.length - 1;
            const next =
              event.key === 'ArrowRight'
                ? tabs[index === last ? 0 : index + 1]
                : event.key === 'ArrowLeft'
                  ? tabs[index === 0 ? last : index - 1]
                  : event.key === 'Home'
                    ? tabs[0]
                    : event.key === 'End'
                      ? tabs[last]
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onChange(next.id);
            buttonsRef.current.get(next.id)?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A whole number in a field. What is typed stays as typed, so the field can be emptied
 * on the way to another number; an empty field is no number, which the save refuses.
 */
export function WholeNumberInput({
  control,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  readonly control: ControlProps;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): ReactElement {
  const [text, setText] = useState(Number.isNaN(value) ? '' : String(value));
  return (
    <Input
      {...control}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      className="w-32"
      value={text}
      disabled={disabled}
      onValueChange={(typed) => {
        setText(typed);
        onChange(typed.trim() === '' ? Number.NaN : Number(typed));
      }}
    />
  );
}

/** Whether calls can be made or taken now, said before any setting. */
export function CallingNotice({ calling }: { readonly calling: PhoneCalling }): ReactElement {
  const { t } = useLingui();
  const id = useId();
  if (calling.available)
    return (
      <p
        role="status"
        className="rounded-xl border border-border bg-card px-4 py-3 text-md leading-relaxed"
      >
        {t`Calls can be made from this business's numbers and are answered here.`}
      </p>
    );
  const text = {
    no_voice_number: t`None of this business's registered numbers can take calls, so no call can be made or taken yet. Register a number with voice from your Twilio account to start. Everything set here is saved and used once one is registered.`,
    calling_not_set_up: t`Calling isn't set up on the Twilio account your numbers come from. Set it up under Calling below. Everything set here is saved and used once calls work.`,
    calling_setup_pending: t`Calling is being set up on your Twilio account. This takes a moment.`,
    calling_setup_failed: t`Setting up calling on your Twilio account failed. See why under Calling below, then try again.`,
    calling_setup_unknown: t`Twilio didn't confirm whether calling was set up. Check under Calling below before setting it up again.`,
  } satisfies Record<NonNullable<PhoneCalling['unavailable']>['code'], string>;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-attention bg-card px-4 py-3"
    >
      <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-body" strokeWidth={1.8} />
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={`${id}-title`} className="text-md font-semibold">
          {t`Calls aren't available yet`}
        </h2>
        <p className="text-md leading-relaxed text-body">
          {calling.unavailable === null ? null : text[calling.unavailable.code]}
        </p>
      </div>
    </section>
  );
}

export function useWarningWords(): (warning: PhoneNumberWarningCode) => string {
  const { t } = useLingui();
  const text = {
    no_destination: t`A call to this number reaches nobody and leaves no voicemail.`,
    short_ring_timeout: t`It rings for under 20 seconds, which can be too short to answer.`,
    member_left: t`Someone chosen here left the team and is no longer rung.`,
    fallback_not_set: t`It falls back to the business fallback number, which isn't set.`,
  } satisfies Record<PhoneNumberWarningCode, string>;
  return (warning) => text[warning];
}

export function useStatusWords(): (status: PhoneNumberSettings['status']) => string {
  const { t } = useLingui();
  const text = {
    active: t`Active`,
    paused: t`Paused`,
    failing: t`Failing`,
    disconnected: t`Disconnected`,
  } satisfies Record<PhoneNumberSettings['status'], string>;
  return (status) => text[status];
}

export const statusVariant = {
  active: 'assistant',
  paused: 'neutral',
  failing: 'attention',
  disconnected: 'attention',
} as const satisfies Record<PhoneNumberSettings['status'], string>;

const longest: Readonly<Record<string, number>> = {
  '/name': 120,
  '/voice/recording/announcement/message': 500,
  '/voice/advanced/whisper/message': 500,
  '/missedCallText/message': 640,
};

/**
 * The words under a field the contract or the server refused. The contract's own sentence
 * where it has one; ours for a number out of its range, a name left blank, a message too
 * long, and each refusal only the server can make.
 */
export function useProblemWords(): (pointer: string, problem: FieldProblem) => string {
  const { t } = useLingui();
  const known: Readonly<Record<string, string>> = {
    unavailable_member: t`This person isn't on the team any more. Choose someone else.`,
    forwards_to_own_number: t`Use a number outside this business: a call can't be sent on to one of its own numbers.`,
    number_cannot_call: t`This number can't take calls, so it can't be the default.`,
  };
  return (pointer, problem) => {
    const server = known[problem.code];
    if (server !== undefined) return server;
    if (problem.code === 'custom') return problem.message;
    const max = longest[pointer];
    if (problem.code === 'too_big' && max !== undefined) {
      const most = String(max);
      return t`Use at most ${most} characters.`;
    }
    if (pointer === '/name') return t`Give the number a name.`;
    if (pointer.endsWith('/forwardTo') || pointer.endsWith('/fallbackNumber'))
      return t`Use the full number with its country code, such as +14155550123.`;
    if (pointer.endsWith('/ringTimeoutSeconds')) return t`Use 5 to 120 seconds.`;
    if (pointer.endsWith('/retentionDays')) return t`Use 1 to 3,650 days.`;
    return problem.message;
  };
}
