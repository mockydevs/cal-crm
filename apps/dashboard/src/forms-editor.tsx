// The form builder: a form's name, the websites that may show it, its words, its questions
// with where each answer is saved, and its consent boxes, beside a preview. The draft is
// checked by the API's own schema before it is sent; what depends on the business (a
// contact field that was archived, no website listed) comes back from the API as problems,
// shown by the part they are about.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  archiveForm,
  FORM_LIMITS,
  formFieldTypes,
  publishForm,
  restoreForm,
  unpublishForm,
  updateForm,
  updateFormInput,
  type FieldDefinition,
  type Form,
  type FormContactAttribute,
  type FormDefinition,
  type FormField,
  type FormFieldType,
  type UpdateFormInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import {
  choiceKey,
  draftOf,
  freeChannels,
  inputOf,
  isChanged,
  moved,
  placed,
  answerless,
  isChoice,
  isChoiceField,
  retargeted,
  retyped,
  takesPlaceholder,
  takesQueryKey,
  targetChoices,
  targetOf,
  targetValue,
  withConsent,
  unseen,
  withConsentChange,
  withExtra,
  withField,
  withQuestion,
  type FormDraft,
  type PlacedProblems,
} from './forms-rules';
import { FormLink, FormSubmitSettings } from './forms-extras';
import { issuesOf } from './problems';

const typeNames: Readonly<Record<FormFieldType, MessageDescriptor>> = {
  text: msg`Short answer`,
  long_text: msg`Long answer`,
  email: msg`Email address`,
  phone: msg`Phone number`,
  number: msg`Number`,
  date: msg`Date`,
  single_choice: msg`One choice from a list`,
  checkbox: msg`Checkbox`,
  multi_choice: msg`Several choices from a list`,
  url: msg`Website address`,
  rating: msg`Rating, 1 to 5`,
  hidden: msg`Hidden field`,
  content: msg`Text on the form`,
  terms: msg`Terms to agree to`,
};
const attributeNames: Readonly<Record<FormContactAttribute, MessageDescriptor>> = {
  firstName: msg`Contact: first name`,
  lastName: msg`Contact: last name`,
  email: msg`Contact: email address`,
  phone: msg`Contact: phone number`,
  dateOfBirth: msg`Contact: date of birth`,
};
const channelNames = {
  email: msg`Marketing email`,
  sms: msg`Marketing text messages`,
} as const;

export function useStatusName(): (form: Pick<Form, 'status' | 'hasUnpublishedChanges'>) => string {
  const { t } = useLingui();
  return (form) =>
    form.status === 'archived'
      ? t`Archived`
      : form.status === 'draft'
        ? t`Draft`
        : form.hasUnpublishedChanges
          ? t`Published, with changes not yet published`
          : t`Published`;
}

function Labeled({
  label,
  hint,
  problems = [],
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly problems?: readonly string[];
  readonly children: (id: string, describedBy: string | undefined) => ReactNode;
}): ReactElement {
  const id = useId();
  const described =
    [hint === undefined ? '' : `${id}-hint`, problems.length === 0 ? '' : `${id}-problem`]
      .filter((each) => each !== '')
      .join(' ') || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children(id, described)}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-sm leading-normal text-muted-foreground">
          {hint}
        </p>
      )}
      {problems.length === 0 ? null : (
        <p id={`${id}-problem`} className="text-sm font-medium text-destructive">
          {problems.join(' ')}
        </p>
      )}
    </div>
  );
}

/** What changes a form's state, each from the revision the builder holds. */
type Change = 'publish' | 'unpublish' | 'archive' | 'restore';

/** What a failed request says: the API's own words when it gave some. */
const said = (error: unknown, fallback: string): string =>
  error instanceof ApiError ? error.message : fallback;

export function FormEditor({
  form,
  contactFields,
  client,
  onSaved,
  onReload,
}: {
  readonly form: Form;
  /** The business's field definitions, for the places an answer can be saved. */
  readonly contactFields: readonly FieldDefinition[];
  readonly client: Client;
  /** Told the form as the API now has it, after every change. */
  readonly onSaved: (saved: Form) => void;
  /** Reads the form again, after someone else changed it. */
  readonly onReload: () => Promise<Form | undefined>;
}): ReactElement {
  const { t, i18n } = useLingui();
  const statusName = useStatusName();
  const [draft, setDraft] = useState<FormDraft>(() => draftOf(form));
  const [saved, setSaved] = useState(form);
  const [problems, setProblems] = useState<PlacedProblems>(() => placed(form.problems));
  const [failure, setFailure] = useState<{ text: string; stale: boolean }>();
  const [notice, setNotice] = useState<string>();
  const canManage = saved.canManage;
  const archived = saved.status === 'archived';
  const changed = isChanged(draft, draftOf(saved));
  const definition = draft.definition;
  const setDefinition = (next: FormDefinition): void => {
    setDraft((value) => ({ ...value, definition: next }));
  };
  /** Takes the form as the API now has it. What is typed and not saved yet can be kept. */
  const took = (next: Form, words: string, keepDraft = false): void => {
    setSaved(next);
    if (!keepDraft) setDraft(draftOf(next));
    setProblems(placed(next.problems));
    setFailure(undefined);
    setNotice(words);
    onSaved(next);
  };
  const failed = (error: unknown, fallback: string): void => {
    setNotice(undefined);
    const issues = error instanceof ApiError ? (error.problem.errors ?? []) : [];
    if (issues.length > 0) {
      setProblems(placed(issues));
      setFailure({ text: t`Check the parts marked below.`, stale: false });
      return;
    }
    setFailure({
      text: said(error, fallback),
      stale: error instanceof ApiError && error.status === 409,
    });
  };
  const save = useMutation({
    mutationFn: (body: UpdateFormInput) =>
      client.request(updateForm, { params: { id: saved.id }, body }),
    onSuccess: (next) => {
      took(next, t`Saved.`);
    },
    onError: (error) => {
      failed(error, t`The form wasn't saved. Check your connection and try again.`);
    },
  });
  const act = useMutation({
    mutationFn: (change: Change) => {
      const input = { params: { id: saved.id }, body: { revision: saved.revision } };
      switch (change) {
        case 'publish':
          return client.request(publishForm, input);
        case 'unpublish':
          return client.request(unpublishForm, input);
        case 'archive':
          return client.request(archiveForm, input);
        case 'restore':
          return client.request(restoreForm, input);
      }
    },
    onSuccess: (next, change) => {
      const words = {
        publish: t`Published. Websites now show this version.`,
        unpublish: t`Unpublished. The form no longer accepts submissions.`,
        archive: t`Archived.`,
        restore: t`Restored as a draft.`,
      } satisfies Record<Change, string>;
      // Taking a form down or putting it away changes its state, not its questions: what
      // is typed and not saved yet stays in the builder.
      took(next, words[change], changed);
    },
    onError: (error) => {
      failed(error, t`The form wasn't changed. Check your connection and try again.`);
    },
  });
  const busy = save.isPending || act.isPending;
  const disabled = !canManage || archived || busy;
  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold break-words">{saved.name}</h2>
        <Badge variant={saved.status === 'published' ? 'neutral' : 'attention'}>
          {statusName(saved)}
        </Badge>
      </div>
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>You can read this form. Changing it needs permission to manage forms.</Trans>
        </p>
      )}
      <div className="grid min-w-0 items-start gap-[18px] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <form
          className="flex min-w-0 flex-col gap-[18px]"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setNotice(undefined);
            const input = inputOf(draft, saved.revision);
            const parsed = updateFormInput.safeParse(input);
            if (!parsed.success) {
              setProblems(placed(issuesOf(parsed.error)));
              setFailure({ text: t`Check the parts marked below.`, stale: false });
              return;
            }
            setFailure(undefined);
            save.mutate(parsed.data);
          }}
        >
          <fieldset
            disabled={disabled}
            className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-[22px]"
          >
            <legend className="sr-only">
              <Trans>Form settings</Trans>
            </legend>
            <Labeled
              label={t`Name`}
              hint={t`Only your team sees it, to tell one form from another.`}
              problems={problems.name}
            >
              {(id, described) => (
                <Input
                  id={id}
                  aria-describedby={described}
                  value={draft.name}
                  required
                  maxLength={FORM_LIMITS.nameLength}
                  onValueChange={(name) => {
                    setDraft((value) => ({ ...value, name }));
                  }}
                />
              )}
            </Labeled>
            <Labeled
              label={t`Websites that may show this form`}
              hint={t`One address a line, exactly as in the browser: https://www.example.com and https://example.com are two websites. The form answers on these and nowhere else.`}
              problems={problems.websites}
            >
              {(id, described) => (
                <Textarea
                  id={id}
                  aria-describedby={described}
                  rows={3}
                  value={draft.websites}
                  placeholder="https://www.example.com"
                  spellCheck={false}
                  onValueChange={(websites) => {
                    setDraft((value) => ({ ...value, websites }));
                  }}
                />
              )}
            </Labeled>
            <Labeled
              label={t`Heading`}
              hint={t`Shown above the questions. Leave it empty to show none.`}
            >
              {(id, described) => (
                <Input
                  id={id}
                  aria-describedby={described}
                  value={definition.title}
                  maxLength={FORM_LIMITS.titleLength}
                  onValueChange={(title) => {
                    setDefinition({ ...definition, title });
                  }}
                />
              )}
            </Labeled>
            <Labeled label={t`Introduction`}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={definition.description}
                  maxLength={FORM_LIMITS.descriptionLength}
                  onValueChange={(description) => {
                    setDefinition({ ...definition, description });
                  }}
                />
              )}
            </Labeled>
            <Labeled label={t`Words on the button`}>
              {(id) => (
                <Input
                  id={id}
                  value={definition.submitLabel}
                  required
                  maxLength={FORM_LIMITS.submitLabelLength}
                  onValueChange={(submitLabel) => {
                    setDefinition({ ...definition, submitLabel });
                  }}
                />
              )}
            </Labeled>
            <Labeled label={t`Message after sending`}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={definition.successMessage}
                  required
                  maxLength={FORM_LIMITS.successLength}
                  onValueChange={(successMessage) => {
                    setDefinition({ ...definition, successMessage });
                  }}
                />
              )}
            </Labeled>
            <Labeled
              label={t`Bot protection`}
              hint={t`Proof of work asks the visitor's browser to solve a small puzzle by itself before the form is sent (ALTCHA, run on this server). Visitors see and do nothing extra.`}
            >
              {(id, described) => (
                <Select
                  id={id}
                  {...(described === undefined ? {} : { 'aria-describedby': described })}
                  value={definition.botProtection ?? 'off'}
                  onValueChange={(value) => {
                    // Left out, as a form without it was saved: off.
                    const { botProtection: _off, ...rest } = definition;
                    setDefinition(value === 'altcha' ? { ...rest, botProtection: 'altcha' } : rest);
                  }}
                >
                  <option value="off">{t`Off`}</option>
                  <option value="altcha">{t`Proof of work (ALTCHA)`}</option>
                </Select>
              )}
            </Labeled>
          </fieldset>

          <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-1 text-lg font-semibold">
              <Trans>Questions</Trans>
            </legend>
            {definition.fields.length === 0 ? (
              <p className="text-muted-foreground">
                <Trans>No questions yet.</Trans>
              </p>
            ) : null}
            <ol className="flex list-none flex-col gap-3 p-0">
              {definition.fields.map((field, index) => {
                const choices = targetChoices(definition, index, contactFields);
                const number = String(index + 1);
                const fills = field.target.kind === 'field' ? field.target.fieldId : undefined;
                const own = contactFields.find((each) => each.id === fills);
                // A choice question that fills a contact field shows that field's choices.
                const lockedChoices = isChoice(field.type) && own !== undefined;
                const replace = (next: FormField): void => {
                  setDefinition({
                    ...definition,
                    fields: definition.fields.map((each, place) => (place === index ? next : each)),
                  });
                };
                const questionLabel = field.label;
                return (
                  <li
                    key={field.key}
                    aria-label={t`Question ${number}: ${questionLabel}`}
                    className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-[18px]"
                  >
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <Labeled label={t`Question ${number}`}>
                        {(id) => (
                          <Input
                            id={id}
                            value={field.label}
                            required
                            maxLength={FORM_LIMITS.labelLength}
                            onValueChange={(label) => {
                              setDefinition(withField(definition, index, { label }));
                            }}
                          />
                        )}
                      </Labeled>
                      <Labeled label={t`Kind of answer for question ${number}`}>
                        {(id) => (
                          <Select
                            id={id}
                            value={field.type}
                            onValueChange={(value) => {
                              const type = formFieldTypes.find((each) => each === value);
                              if (type === undefined) return;
                              setDefinition({
                                ...definition,
                                fields: definition.fields.map((each, place) =>
                                  place === index ? retyped(each, type, contactFields) : each,
                                ),
                              });
                            }}
                          >
                            {formFieldTypes.map((type) => (
                              <option key={type} value={type}>
                                {i18n._(typeNames[type])}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Labeled>
                    </div>
                    {answerless(field.type) ? null : (
                      <Labeled
                        label={t`Where the answer to question ${number} is saved`}
                        hint={t`An answer always stays with the submission. It can also fill a part of the contact.`}
                      >
                        {(id, described) => (
                          <Select
                            id={id}
                            {...(described === undefined ? {} : { 'aria-describedby': described })}
                            value={targetValue(field.target)}
                            onValueChange={(value) => {
                              setDefinition({
                                ...definition,
                                fields: definition.fields.map((each, place) =>
                                  place === index
                                    ? retargeted(each, targetOf(value), contactFields)
                                    : each,
                                ),
                              });
                            }}
                          >
                            <option value="none">{t`Only kept with the submission`}</option>
                            {choices.attributes.map((attribute) => (
                              <option key={attribute} value={`contact:${attribute}`}>
                                {i18n._(attributeNames[attribute])}
                              </option>
                            ))}
                            {choices.fields.map((each) => {
                              const fieldLabel = each.label;
                              return (
                                <option key={each.id} value={`field:${each.id}`}>
                                  {each.archived
                                    ? t`Contact field: ${fieldLabel} (archived)`
                                    : t`Contact field: ${fieldLabel}`}
                                </option>
                              );
                            })}
                            {fills !== undefined && own === undefined ? (
                              <option
                                value={`field:${fills}`}
                              >{t`A contact field that no longer exists`}</option>
                            ) : null}
                          </Select>
                        )}
                      </Labeled>
                    )}
                    {unseen(field.type) ? null : (
                      <Labeled label={t`Hint under question ${number}`}>
                        {(id) => (
                          <Input
                            id={id}
                            value={field.helpText}
                            maxLength={FORM_LIMITS.helpLength}
                            onValueChange={(helpText) => {
                              setDefinition(withField(definition, index, { helpText }));
                            }}
                          />
                        )}
                      </Labeled>
                    )}
                    <QuestionExtras field={field} number={number} onChange={replace} fills={own} />
                    {isChoice(field.type) ? (
                      <div className="flex min-w-0 flex-col gap-2">
                        <p className="text-sm font-medium">
                          <Trans>Choices</Trans>
                        </p>
                        {lockedChoices ? (
                          <p className="text-sm text-muted-foreground">
                            <Trans>
                              These are the choices of the contact field this question fills. Change
                              them in Settings, under Custom Fields &amp; Tags.
                            </Trans>
                          </p>
                        ) : null}
                        {field.options.map((option, place) => {
                          const choiceNumber = String(place + 1);
                          return (
                            <div key={option.key} className="flex min-w-0 items-end gap-2">
                              <div className="min-w-0 flex-1">
                                <Labeled label={t`Choice ${choiceNumber} of question ${number}`}>
                                  {(id) => (
                                    <Input
                                      id={id}
                                      value={option.label}
                                      required
                                      maxLength={FORM_LIMITS.optionLabelLength}
                                      onValueChange={(label) => {
                                        setDefinition(
                                          withField(definition, index, {
                                            options: field.options.map((each, at) =>
                                              at === place ? { ...each, label } : each,
                                            ),
                                          }),
                                        );
                                      }}
                                    />
                                  )}
                                </Labeled>
                              </div>
                              {lockedChoices ? null : (
                                <Button
                                  type="button"
                                  variant="quiet"
                                  aria-label={t`Remove choice ${choiceNumber} of question ${number}`}
                                  onClick={() => {
                                    setDefinition(
                                      withField(definition, index, {
                                        options: field.options.filter((_each, at) => at !== place),
                                      }),
                                    );
                                  }}
                                >
                                  <Trans>Remove</Trans>
                                </Button>
                              )}
                            </div>
                          );
                        })}
                        {lockedChoices || field.options.length >= FORM_LIMITS.options ? null : (
                          <Button
                            type="button"
                            variant="quiet"
                            className="self-start"
                            aria-label={t`Add a choice to question ${number}`}
                            onClick={() => {
                              const label = t`New choice`;
                              setDefinition(
                                withField(definition, index, {
                                  options: [
                                    ...field.options,
                                    {
                                      key: choiceKey(
                                        label,
                                        field.options.map((each) => each.key),
                                      ),
                                      label,
                                    },
                                  ],
                                }),
                              );
                            }}
                          >
                            <Trans>Add a choice</Trans>
                          </Button>
                        )}
                      </div>
                    ) : null}
                    {unseen(field.type) ? null : (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={field.required}
                          onChange={(event) => {
                            setDefinition(
                              withField(definition, index, { required: event.target.checked }),
                            );
                          }}
                        />
                        {field.type === 'terms'
                          ? t`Question ${number} must be agreed to`
                          : t`Question ${number} must be answered`}
                      </label>
                    )}
                    {(problems.fields.get(index) ?? []).length === 0 ? null : (
                      <p className="text-sm font-medium text-destructive">
                        {(problems.fields.get(index) ?? []).join(' ')}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="small"
                        variant="quiet"
                        disabled={index === 0}
                        aria-label={t`Move question ${number} up`}
                        onClick={() => {
                          setDefinition({
                            ...definition,
                            fields: moved(definition.fields, index, -1),
                          });
                        }}
                      >
                        <Trans>Move up</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="small"
                        variant="quiet"
                        disabled={index === definition.fields.length - 1}
                        aria-label={t`Move question ${number} down`}
                        onClick={() => {
                          setDefinition({
                            ...definition,
                            fields: moved(definition.fields, index, 1),
                          });
                        }}
                      >
                        <Trans>Move down</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="small"
                        variant="quiet"
                        aria-label={t`Remove question ${number}`}
                        onClick={() => {
                          setDefinition({
                            ...definition,
                            fields: definition.fields.filter((_each, place) => place !== index),
                          });
                        }}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
            {definition.fields.length >= FORM_LIMITS.fields ? null : (
              <Button
                type="button"
                variant="secondary"
                className="self-start"
                onClick={() => {
                  setDefinition(withQuestion(definition, t`New question`));
                }}
              >
                <Trans>Add a question</Trans>
              </Button>
            )}
          </fieldset>

          <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-1 text-lg font-semibold">
              <Trans>Consent boxes</Trans>
            </legend>
            <p className="max-w-[720px] text-sm leading-relaxed text-muted-foreground">
              <Trans>
                A box a visitor may tick to agree to marketing messages. It is never ticked for
                them. The exact words, the form, the time and the visitor's address are kept with
                their consent, as proof of what they agreed to.
              </Trans>
            </p>
            <ul className="flex list-none flex-col gap-3 p-0">
              {definition.consents.map((consent, index) => {
                const number = String(index + 1);
                const free = freeChannels(definition);
                return (
                  <li
                    key={consent.key}
                    className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-[18px]"
                  >
                    <Labeled label={t`What consent box ${number} is for`}>
                      {(id) => (
                        <Select
                          id={id}
                          value={consent.channel}
                          onValueChange={(value) => {
                            if (value === 'email' || value === 'sms')
                              setDefinition(
                                withConsentChange(definition, index, { channel: value }),
                              );
                          }}
                        >
                          {(['email', 'sms'] as const)
                            .filter(
                              (channel) => channel === consent.channel || free.includes(channel),
                            )
                            .map((channel) => (
                              <option key={channel} value={channel}>
                                {i18n._(channelNames[channel])}
                              </option>
                            ))}
                        </Select>
                      )}
                    </Labeled>
                    <Labeled label={t`Words beside consent box ${number}`}>
                      {(id) => (
                        <Input
                          id={id}
                          value={consent.wording}
                          required
                          maxLength={FORM_LIMITS.wordingLength}
                          onValueChange={(wording) => {
                            setDefinition(withConsentChange(definition, index, { wording }));
                          }}
                        />
                      )}
                    </Labeled>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={consent.required}
                        onChange={(event) => {
                          setDefinition(
                            withConsentChange(definition, index, {
                              required: event.target.checked,
                            }),
                          );
                        }}
                      />
                      {t`The form can't be sent without consent box ${number} ticked`}
                    </label>
                    {(problems.consents.get(index) ?? []).length === 0 ? null : (
                      <p className="text-sm font-medium text-destructive">
                        {(problems.consents.get(index) ?? []).join(' ')}
                      </p>
                    )}
                    <Button
                      type="button"
                      size="small"
                      variant="quiet"
                      className="self-start"
                      aria-label={t`Remove consent box ${number}`}
                      onClick={() => {
                        setDefinition({
                          ...definition,
                          consents: definition.consents.filter((_each, place) => place !== index),
                        });
                      }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </li>
                );
              })}
            </ul>
            {freeChannels(definition).length === 0 ? null : (
              <Button
                type="button"
                variant="secondary"
                className="self-start"
                onClick={() => {
                  setDefinition(withConsent(definition, t`Email me news and offers.`));
                }}
              >
                <Trans>Add a consent box</Trans>
              </Button>
            )}
          </fieldset>

          <FormSubmitSettings
            formId={saved.id}
            formName={draft.name}
            definition={definition}
            disabled={disabled}
            unsaved={changed}
            client={client}
            onChange={setDefinition}
          />

          {problems.form.length === 0 ? null : (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm font-medium text-destructive">
              {problems.form.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {failure === undefined ? null : (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-sm text-destructive"
            >
              <span>{failure.text}</span>
              {failure.stale ? (
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  onClick={() => {
                    void onReload().then((fresh) => {
                      if (fresh === undefined) return;
                      took(fresh, t`Reloaded. Your unsaved changes were replaced.`);
                    });
                  }}
                >
                  <Trans>Reload the saved form</Trans>
                </Button>
              ) : null}
            </div>
          )}
          <p role="status" className="text-sm empty:sr-only">
            {notice}
          </p>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              {archived ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    act.mutate('restore');
                  }}
                >
                  <Trans>Restore as a draft</Trans>
                </Button>
              ) : (
                <>
                  <Button type="submit" disabled={busy || !changed}>
                    {save.isPending ? t`Saving…` : t`Save draft`}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      busy ||
                      changed ||
                      saved.problems.length > 0 ||
                      (saved.status === 'published' && !saved.hasUnpublishedChanges)
                    }
                    onClick={() => {
                      act.mutate('publish');
                    }}
                  >
                    {saved.status === 'published' ? t`Publish changes` : t`Publish`}
                  </Button>
                  {saved.status === 'published' ? (
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={busy}
                      onClick={() => {
                        act.mutate('unpublish');
                      }}
                    >
                      <Trans>Unpublish</Trans>
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={busy}
                    onClick={() => {
                      act.mutate('archive');
                    }}
                  >
                    <Trans>Archive</Trans>
                  </Button>
                </>
              )}
            </div>
          ) : null}
          {canManage && !archived && changed ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Save your changes before publishing.</Trans>
            </p>
          ) : null}
          {canManage && !archived && !changed && saved.problems.length > 0 ? (
            <div className="rounded-card bg-secondary p-3 text-sm text-secondary-foreground">
              <p className="font-semibold">
                <Trans>Before this form can be published</Trans>
              </p>
              <ul className="mt-1 list-disc pl-5">
                {saved.problems.map((problem) => (
                  <li key={`${problem.path} ${problem.code}`}>{problem.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </form>
        <FormPreview definition={definition} />
      </div>
      <div className="grid min-w-0 items-start gap-[18px] lg:grid-cols-2">
        <FormLink form={saved} client={client} />
        {saved.status === 'published' ? <EmbedCode form={saved} /> : null}
      </div>
    </div>
  );
}

/**
 * The form as a visitor will see it, built from the draft as it is typed. Every word is put
 * on the page as text: a label that contains markup shows the characters it is made of.
 * Nothing here can be filled in or sent.
 */
export function FormPreview({ definition }: { readonly definition: FormDefinition }): ReactElement {
  const { t } = useLingui();
  const hiddenNote = (name: string) =>
    t`Hidden field “${name}”: filled in from the page, never shown.`;
  const headingId = useId();
  const required = t`(required)`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-secondary p-[18px]"
    >
      <h3 id={headingId} className="text-sm font-semibold text-muted-foreground">
        <Trans>Preview</Trans>
      </h3>
      <div className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-5">
        {definition.title === '' ? null : (
          <p className="text-xl font-semibold break-words">{definition.title}</p>
        )}
        {definition.description === '' ? null : (
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {definition.description}
          </p>
        )}
        {definition.fields.map((field) => (
          <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
            {field.type === 'hidden' ? (
              // Told to the builder only: a visitor never sees a hidden field.
              <span className="rounded-control border border-dashed border-input px-2.5 py-1.5 text-xs break-words text-muted-foreground">
                {hiddenNote(field.label)}
              </span>
            ) : field.type === 'content' ? (
              <p
                className={
                  field.style === 'heading'
                    ? 'text-lg font-semibold break-words'
                    : 'break-words whitespace-pre-wrap text-muted-foreground'
                }
              >
                {field.text ?? ''}
              </p>
            ) : field.type === 'terms' ? (
              <label className="flex items-start gap-2 text-sm break-words">
                <input type="checkbox" className="mt-0.5 size-4" disabled />
                <span>
                  {field.text ?? ''}
                  {field.linkUrl === undefined ? null : (
                    <>
                      {' '}
                      <span className="text-link underline">
                        {field.linkLabel ?? field.linkUrl}
                      </span>
                    </>
                  )}
                  {field.required ? <> {required}</> : null}
                </span>
              </label>
            ) : field.type === 'checkbox' ? (
              <label className="flex items-start gap-2 text-sm break-words">
                <input type="checkbox" className="mt-0.5 size-4" disabled />
                <span>
                  {field.label}
                  {field.required ? <> {required}</> : null}
                </span>
              </label>
            ) : (
              <>
                <span className="text-sm font-medium break-words">
                  {field.label}
                  {field.required ? <> {required}</> : null}
                </span>
                {field.type === 'rating' ? (
                  <span
                    aria-hidden="true"
                    className="text-lg tracking-widest text-muted-foreground"
                  >
                    ☆☆☆☆☆
                  </span>
                ) : field.type === 'single_choice' || field.type === 'multi_choice' ? (
                  <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
                    {field.options.map((option) => (
                      <li key={option.key} className="break-words">
                        {option.label}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span
                    aria-hidden="true"
                    className={
                      field.type === 'long_text'
                        ? 'block h-20 rounded-xl border border-input px-3 py-2 text-sm text-muted-foreground'
                        : 'flex h-11 items-center rounded-xl border border-input px-3 text-sm text-muted-foreground'
                    }
                  >
                    {field.placeholder ?? ''}
                  </span>
                )}
              </>
            )}
            {field.helpText === '' || field.type === 'hidden' || field.type === 'content' ? null : (
              <span className="text-sm break-words text-muted-foreground">{field.helpText}</span>
            )}
          </div>
        ))}
        {definition.consents.map((consent) => (
          <label key={consent.key} className="flex items-start gap-2 text-sm break-words">
            <input type="checkbox" className="mt-0.5 size-4" disabled />
            <span>
              {consent.wording}
              {consent.required ? <> {required}</> : null}
            </span>
          </label>
        ))}
        <span className="inline-flex min-h-11 w-fit max-w-full items-center rounded-full bg-primary px-6 font-semibold break-words text-primary-foreground">
          {definition.submitLabel}
        </span>
      </div>
    </section>
  );
}

/** The one line a website needs, shown as text, with a button that copies it. */
function EmbedCode({ form }: { readonly form: Form }): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState<'copied' | 'failed'>();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-[22px] text-sm"
    >
      <h3 id={headingId} className="text-lg font-semibold">
        <Trans>Code for your website</Trans>
      </h3>
      <p className="text-muted-foreground">
        <Trans>
          Paste it where the form should appear, on a page of a website listed above. A website with
          a Content-Security-Policy must allow this install for script-src and connect-src.
        </Trans>
      </p>
      {/* As text: the code is shown, never run or parsed here. It wraps, so it never scrolls. */}
      <p className="rounded-xl bg-secondary p-3 font-mono text-xs break-all">{form.embedSnippet}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            navigator.clipboard.writeText(form.embedSnippet).then(
              () => {
                setCopied('copied');
              },
              () => {
                setCopied('failed');
              },
            );
          }}
        >
          <Trans>Copy the code</Trans>
        </Button>
        <span role="status" className="empty:sr-only">
          {copied === 'copied'
            ? t`Copied.`
            : copied === 'failed'
              ? t`Couldn't copy. Select the code and copy it yourself.`
              : null}
        </span>
      </div>
    </section>
  );
}

/**
 * The settings only some kinds of question have: a placeholder, how choices are laid out,
 * where a hidden field takes its value, the words of a text block or of terms to agree to.
 */
function QuestionExtras({
  field,
  number,
  onChange,
  fills,
}: {
  readonly field: FormField;
  readonly number: string;
  readonly onChange: (next: FormField) => void;
  /** The contact field the question fills, when it fills one. */
  readonly fills?: FieldDefinition | undefined;
}): ReactElement | null {
  const { t } = useLingui();
  const { type } = field;
  const fallbackLabel = t`Value for question ${number} when the page gives none`;
  if (type === 'hidden')
    return (
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Labeled
          label={t`Page address parameter for question ${number}`}
          hint={t`The form reads it from the address of the page it is on, such as ?utm_campaign=june. Visitors never see this question.`}
        >
          {(id, described) => (
            <Input
              id={id}
              {...(described === undefined ? {} : { 'aria-describedby': described })}
              value={field.parameter ?? ''}
              placeholder="utm_campaign"
              maxLength={60}
              onValueChange={(value) => {
                onChange(withExtra(field, 'parameter', value.trim()));
              }}
            />
          )}
        </Labeled>
        <Labeled
          label={fallbackLabel}
          hint={
            fills !== undefined && isChoiceField(fills)
              ? t`Optional. One of the field's choices. The page's value is matched to a choice by its name or key.`
              : t`Optional. Kept on your side: it is never sent to the visitor's browser.`
          }
        >
          {(id, described) =>
            fills !== undefined && isChoiceField(fills) ? (
              <HiddenChoiceDefault
                id={id}
                label={fallbackLabel}
                described={described}
                field={field}
                fills={fills}
                onChange={onChange}
              />
            ) : (
              <Input
                id={id}
                {...(described === undefined ? {} : { 'aria-describedby': described })}
                value={field.defaultValue ?? ''}
                maxLength={500}
                onValueChange={(value) => {
                  onChange(withExtra(field, 'defaultValue', value));
                }}
              />
            )
          }
        </Labeled>
      </div>
    );
  if (type === 'content')
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <Labeled label={t`How the text of question ${number} looks`}>
          {(id) => (
            <Select
              id={id}
              value={field.style ?? 'paragraph'}
              onValueChange={(value) => {
                const { style: _style, ...rest } = field;
                onChange(value === 'heading' ? { ...rest, style: 'heading' } : rest);
              }}
            >
              <option value="paragraph">{t`Paragraph`}</option>
              <option value="heading">{t`Heading`}</option>
            </Select>
          )}
        </Labeled>
        <Labeled label={t`Text shown for question ${number}`}>
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={field.text ?? ''}
              required
              maxLength={FORM_LIMITS.contentLength}
              onValueChange={(value) => {
                onChange(withExtra(field, 'text', value));
              }}
            />
          )}
        </Labeled>
      </div>
    );
  if (type === 'terms')
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <Labeled label={t`Wording of the box for question ${number}`}>
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={field.text ?? ''}
              required
              maxLength={FORM_LIMITS.contentLength}
              onValueChange={(value) => {
                onChange(withExtra(field, 'text', value));
              }}
            />
          )}
        </Labeled>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Labeled
            label={t`Link to the terms for question ${number}`}
            hint={t`Optional. A secure address, starting with https://.`}
          >
            {(id, described) => (
              <Input
                id={id}
                type="url"
                {...(described === undefined ? {} : { 'aria-describedby': described })}
                value={field.linkUrl ?? ''}
                placeholder="https://"
                maxLength={FORM_LIMITS.urlLength}
                onValueChange={(value) => {
                  onChange(withExtra(field, 'linkUrl', value.trim()));
                }}
              />
            )}
          </Labeled>
          <Labeled label={t`Words of the link for question ${number}`}>
            {(id) => (
              <Input
                id={id}
                value={field.linkLabel ?? ''}
                maxLength={FORM_LIMITS.linkLabelLength}
                onValueChange={(value) => {
                  onChange(withExtra(field, 'linkLabel', value));
                }}
              />
            )}
          </Labeled>
        </div>
      </div>
    );
  return (
    <>
      {takesPlaceholder(type) ? (
        <Labeled label={t`Placeholder in the box of question ${number}`}>
          {(id) => (
            <Input
              id={id}
              value={field.placeholder ?? ''}
              maxLength={FORM_LIMITS.placeholderLength}
              onValueChange={(value) => {
                onChange(withExtra(field, 'placeholder', value));
              }}
            />
          )}
        </Labeled>
      ) : null}
      {takesQueryKey(type) ? (
        <Labeled
          label={t`Fill question ${number} from the page address: parameter name`}
          hint={t`Optional. With promo here, a page opened as …?promo=SPRING shows this question already filled with SPRING; the visitor can change it.`}
        >
          {(id, described) => (
            <Input
              id={id}
              {...(described === undefined ? {} : { 'aria-describedby': described })}
              value={field.parameter ?? ''}
              placeholder="promo"
              autoCapitalize="none"
              maxLength={60}
              onValueChange={(value) => {
                onChange(withExtra(field, 'parameter', value.trim()));
              }}
            />
          )}
        </Labeled>
      ) : null}
      {isChoice(type) ? (
        <Labeled label={t`How the choices of question ${number} are shown`}>
          {(id) => (
            <Select
              id={id}
              value={field.display ?? 'dropdown'}
              onValueChange={(value) => {
                const { display: _display, ...rest } = field;
                onChange(
                  value === 'radio' && type === 'single_choice'
                    ? { ...rest, display: 'radio' }
                    : value === 'checkboxes' && type === 'multi_choice'
                      ? { ...rest, display: 'checkboxes' }
                      : rest,
                );
              }}
            >
              <option value="dropdown">{t`A dropdown`}</option>
              {type === 'single_choice' ? (
                <option value="radio">{t`Radio buttons`}</option>
              ) : (
                <option value="checkboxes">{t`Checkboxes`}</option>
              )}
            </Select>
          )}
        </Labeled>
      ) : null}
    </>
  );
}

/**
 * A hidden question's fixed answer for a choice field: one of the field's choices, or for a
 * field that takes several, any of them. Stored as their keys, separated by commas.
 */
function HiddenChoiceDefault({
  id,
  label,
  described,
  field,
  fills,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly described: string | undefined;
  readonly field: FormField;
  readonly fills: FieldDefinition;
  readonly onChange: (next: FormField) => void;
}): ReactElement {
  const { t } = useLingui();
  const live = fills.options.filter((option) => !option.archived);
  const chosen = (field.defaultValue ?? '')
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
  const set = (keys: readonly string[]): void => {
    onChange(withExtra(field, 'defaultValue', keys.join(', ')));
  };
  if (fills.valueType === 'single_choice')
    return (
      <Select
        id={id}
        {...(described === undefined ? {} : { 'aria-describedby': described })}
        value={chosen[0] ?? ''}
        onValueChange={(value) => {
          set(value === '' ? [] : [value]);
        }}
      >
        <option value="">{t`No value`}</option>
        {live.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      {...(described === undefined ? {} : { 'aria-describedby': described })}
      className="flex min-w-0 flex-col gap-1"
    >
      {live.map((option) => (
        <label key={option.key} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.includes(option.key)}
            onChange={(event) => {
              set(
                live
                  .map((each) => each.key)
                  .filter((key) =>
                    key === option.key ? event.target.checked : chosen.includes(key),
                  ),
              );
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
