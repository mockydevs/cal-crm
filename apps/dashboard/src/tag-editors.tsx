import { Trans, useLingui } from '@lingui/react/macro';
import {
  getTagConfiguration,
  createTag,
  createTagInput,
  updateTag,
  updateTagInput,
  createTagGroup,
  createTagGroupInput,
  updateTagGroup,
  updateTagGroupInput,
  updateTagRules,
  updateTagRulesInput,
  type TagConfiguration,
  type TagDefinition,
  type TagGroup,
  type TagRules,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { useBusiness } from './workspace';

function savingProblem(error: unknown, fallback: string): Rejection {
  return error instanceof ApiError && error.problem.errors !== undefined
    ? rejection(error.problem.errors)
    : { fields: {}, form: error instanceof ApiError ? error.problem.detail : fallback };
}

function EditorProblem({
  problem,
  stale,
  onReload,
  busy = false,
}: {
  readonly problem: Rejection;
  readonly stale: boolean;
  readonly onReload: () => void;
  readonly busy?: boolean;
}): ReactElement | null {
  return problem.form === undefined ? null : (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-sm font-medium text-destructive">
        {problem.form}
      </p>
      {stale ? (
        <Button variant="secondary" disabled={busy} onClick={onReload}>
          <Trans>Reload saved version</Trans>
        </Button>
      ) : null}
    </div>
  );
}

const normalize = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
/** One inserted, removed or replaced character, after normalizing the tag name. */
function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const first = Array.from(left).findIndex((character, index) => character !== right[index]);
    if (
      first >= 0 &&
      left[first] === right[first + 1] &&
      left[first + 1] === right[first] &&
      left.slice(first + 2) === right.slice(first + 2)
    )
      return true;
  }
  let a = 0;
  let b = 0;
  let edits = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) {
      a++;
      b++;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length >= right.length) a++;
    if (right.length >= left.length) b++;
  }
  return edits + (left.length - a) + (right.length - b) <= 1;
}

export function TagEditor({
  tag,
  configuration,
  onClose,
  onReload,
}: {
  readonly tag: TagDefinition | undefined;
  readonly configuration: TagConfiguration;
  readonly onClose: (message?: string) => void;
  readonly onReload: (saved: TagDefinition) => void;
}): ReactElement {
  const { t } = useLingui();
  const createdNotice = (name: string) => t`Created the tag ${name}.`;
  const existingLabel = (name: string) => t`Use existing ${name}`;
  const existingNotice = (name: string) => t`The tag ${name} already exists.`;
  const business = useBusiness();
  const cache = useQueryClient();
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [name, setName] = useState(tag?.name ?? '');
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      tag === undefined
        ? apiIn(business.id).request(createTag, { body: createTagInput.parse(body) })
        : apiIn(business.id).request(updateTag, {
            params: { id: tag.id },
            body: updateTagInput.parse(body),
          }),
    onSuccess: async (saved) => {
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'tags'] });
      onClose(tag === undefined ? createdNotice(saved.name) : t`Tag saved.`);
    },
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The tag wasn't saved. Check your connection and try again.`),
      );
      if (error instanceof ApiError && error.status === 409)
        void cache.invalidateQueries({ queryKey: ['b', business.id, 'tags'] });
    },
  });
  const normalized = normalize(name);
  const reload = useMutation({
    mutationFn: async () => {
      const latest = await cache.query({
        queryKey: ['b', business.id, 'tags'],
        queryFn: () => apiIn(business.id).request(getTagConfiguration, {}),
        staleTime: 0,
      });
      const saved = latest.items.find((item) => item.id === tag?.id);
      if (saved === undefined) throw new Error('Missing saved tag.');
      return saved;
    },
    onSuccess: onReload,
    onError: (error) => {
      setProblem(savingProblem(error, t`The saved tag couldn't be loaded. Try again.`));
    },
  });
  const similar =
    configuration.rules.suggestSimilar && normalized.length >= 3
      ? configuration.items
          .filter(
            (item) =>
              item.id !== tag?.id &&
              (normalize(item.name).startsWith(normalized) ||
                (normalized.length >= 4 && oneEditApart(normalized, normalize(item.name)))),
          )
          .slice(0, 5)
      : [];
  return (
    <section
      aria-labelledby="tag-editor-heading"
      className="min-w-0 rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id="tag-editor-heading" className="mb-4 text-xl font-semibold">
        {tag === undefined ? t`New tag` : t`Edit tag`}
      </h2>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={(values) => {
          const editable = { name: values['name'], description: values['description'] };
          const groupId =
            typeof values['groupId'] === 'string' && values['groupId'] !== ''
              ? values['groupId']
              : null;
          const parsed =
            tag === undefined
              ? createTagInput.safeParse({ ...editable, ...(groupId === null ? {} : { groupId }) })
              : updateTagInput.safeParse({ ...editable, groupId, revision: tag.revision });
          if (parsed.success) save.mutate(parsed.data);
          else setProblem(rejection(issuesOf(parsed.error)));
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            ref={nameRef}
            value={name}
            onValueChange={setName}
            maxLength={60}
            autoComplete="off"
            className="max-w-sm"
          />
          <FieldDescription>
            <Trans>“Hot lead”, “hot-lead” and “hot_lead” count as the same tag.</Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        {similar.length === 0 ? null : (
          <div className="rounded-control bg-secondary p-3">
            <p className="mb-2 text-sm font-medium">
              <Trans>Similar tags</Trans>
            </p>
            <ul className="flex flex-wrap gap-2">
              {similar.map((item) => (
                <li key={item.id}>
                  <Button
                    variant="secondary"
                    size="small"
                    aria-label={existingLabel(item.name)}
                    onClick={() => {
                      onClose(existingNotice(item.name));
                    }}
                  >
                    {item.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field name="description">
          <FieldLabel>
            <Trans>What it means</Trans>
          </FieldLabel>
          <Textarea defaultValue={tag?.description ?? ''} maxLength={500} />
          <FieldDescription>
            <Trans>
              The assistant reads this to decide when the tag applies. Write it the way you’d
              explain it to a new team member.
            </Trans>
          </FieldDescription>
          <FieldError />
        </Field>
        <Field name="groupId">
          <FieldLabel>
            <Trans>Group</Trans>
          </FieldLabel>
          <Select defaultValue={tag?.groupId ?? ''}>
            <option value="">
              <Trans>No group</Trans>
            </option>
            {configuration.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
          <FieldError />
        </Field>
        <EditorProblem
          problem={problem}
          stale={save.error instanceof ApiError && save.error.status === 409}
          busy={reload.isPending}
          onReload={() => {
            reload.mutate();
          }}
        />
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" disabled={save.isPending}>
            {tag === undefined ? t`Create tag` : t`Save changes`}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}

export function GroupEditor({
  group,
  onClose,
  onReload,
}: {
  readonly group: TagGroup | undefined;
  readonly onClose: (message?: string) => void;
  readonly onReload: (saved: TagGroup) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      group === undefined
        ? apiIn(business.id).request(createTagGroup, { body: createTagGroupInput.parse(body) })
        : apiIn(business.id).request(updateTagGroup, {
            params: { groupId: group.id },
            body: updateTagGroupInput.parse(body),
          }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'tags'] });
      onClose(t`Tag group saved.`);
    },
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The group wasn't saved. Check your connection and try again.`),
      );
      if (error instanceof ApiError && error.status === 409)
        void cache.invalidateQueries({ queryKey: ['b', business.id, 'tags'] });
    },
  });
  const reload = useMutation({
    mutationFn: async () => {
      const latest = await cache.query({
        queryKey: ['b', business.id, 'tags'],
        queryFn: () => apiIn(business.id).request(getTagConfiguration, {}),
        staleTime: 0,
      });
      const saved = latest.groups.find((item) => item.id === group?.id);
      if (saved === undefined) throw new Error('Missing saved group.');
      return saved;
    },
    onSuccess: onReload,
    onError: (error) => {
      setProblem(savingProblem(error, t`The saved group couldn't be loaded. Try again.`));
    },
  });
  return (
    <section
      aria-labelledby="tag-group-editor-heading"
      className="rounded-card border-2 border-primary bg-card p-[22px]"
    >
      <h2 id="tag-group-editor-heading" className="mb-4 text-xl font-semibold">
        {group === undefined ? t`New tag group` : t`Edit tag group`}
      </h2>
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={(values) => {
          const parsed =
            group === undefined
              ? createTagGroupInput.safeParse(values)
              : updateTagGroupInput.safeParse({ ...values, revision: group.revision });
          if (parsed.success) save.mutate(parsed.data);
          else setProblem(rejection(issuesOf(parsed.error)));
        }}
      >
        <Field name="name">
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input ref={nameRef} defaultValue={group?.name ?? ''} maxLength={60} autoComplete="off" />
          <FieldError />
        </Field>
        <Field name="description">
          <FieldLabel>
            <Trans>What it means</Trans>
          </FieldLabel>
          <Textarea defaultValue={group?.description ?? ''} maxLength={500} />
          <FieldError />
        </Field>
        <EditorProblem
          problem={problem}
          stale={save.error instanceof ApiError && save.error.status === 409}
          busy={reload.isPending}
          onReload={() => {
            reload.mutate();
          }}
        />
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" disabled={save.isPending}>
            {group === undefined ? t`Create group` : t`Save group`}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </Form>
    </section>
  );
}

export function TagRulesEditor({
  rules,
  canManage,
  onSaved,
}: {
  readonly rules: TagRules;
  readonly canManage: boolean;
  readonly onSaved: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [creation, setCreation] = useState(rules.creation);
  const [suggestSimilar, setSuggestSimilar] = useState(rules.suggestSimilar);
  const [base, setBase] = useState(rules);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const selectRef = useRef<HTMLButtonElement>(null);
  if (
    base.revision !== rules.revision &&
    creation === base.creation &&
    suggestSimilar === base.suggestSimilar
  ) {
    setBase(rules);
    setCreation(rules.creation);
    setSuggestSimilar(rules.suggestSimilar);
  }
  const save = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(updateTagRules, {
        body: updateTagRulesInput.parse({ creation, suggestSimilar, revision: base.revision }),
      }),
    onSuccess: async (saved) => {
      setBase(saved);
      setCreation(saved.creation);
      setSuggestSimilar(saved.suggestSimilar);
      setProblem(noRejection);
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'tags'] });
      onSaved();
    },
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The rules weren't saved. Check your connection and try again.`),
      );
    },
  });
  return (
    <section aria-labelledby="tag-rules-heading" className="rounded-card border bg-card p-5">
      <h2 id="tag-rules-heading" className="mb-3 text-lg font-semibold">
        <Trans>Tag rules</Trans>
      </h2>
      <form
        className="flex flex-col items-start gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label className="flex w-full max-w-sm flex-col gap-1.5 text-sm font-medium">
          <Trans>Who can create new tags</Trans>
          <Select
            ref={selectRef}
            className="min-h-11 rounded-control border bg-card px-3 text-md"
            disabled={!canManage}
            value={creation}
            onValueChange={(selectedValue) => {
              const value = selectedValue;
              if (value === 'admins' || value === 'everyone') setCreation(value);
            }}
          >
            <option value="admins">
              <Trans>Owners and admins</Trans>
            </option>
            <option value="everyone">
              <Trans>Everyone on the team</Trans>
            </option>
          </Select>
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            role="switch"
            className="size-5 shrink-0 accent-primary"
            disabled={!canManage}
            checked={suggestSimilar}
            onChange={(event) => {
              setSuggestSimilar(event.target.checked);
            }}
          />
          <Trans>Suggest an existing tag when someone types a similar one</Trans>
        </label>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Automations and AI can apply existing tags. People define what each tag means.
          </Trans>
        </p>
        <EditorProblem
          problem={problem}
          stale={save.error instanceof ApiError && save.error.status === 409}
          onReload={() => {
            void cache
              .query({
                queryKey: ['b', business.id, 'tags'],
                queryFn: () => apiIn(business.id).request(getTagConfiguration, {}),
                staleTime: 0,
              })
              .then((configuration) => {
                setBase(configuration.rules);
                setCreation(configuration.rules.creation);
                setSuggestSimilar(configuration.rules.suggestSimilar);
                setProblem(noRejection);
                save.reset();
                selectRef.current?.focus();
              })
              .catch((error: unknown) => {
                setProblem(savingProblem(error, t`The rules couldn't be loaded. Try again.`));
              });
          }}
        />
        {canManage ? (
          <Button type="submit" disabled={save.isPending}>
            <Trans>Save rules</Trans>
          </Button>
        ) : null}
      </form>
    </section>
  );
}
