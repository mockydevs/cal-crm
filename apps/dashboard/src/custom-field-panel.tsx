// The panel a custom field is created and edited in: it slides in from the right over most
// of the window, with the field's details at the left and a live preview of the field at
// the right. Its primary button is on once everything the API requires is there, and
// leaving with something changed asks first. Fetched when first opened, so the list page
// stays light.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  aiFillable,
  createField,
  createFieldInput,
  documentFormats,
  fieldAiSources,
  fieldMergeKey,
  getFields,
  MAX_FIELD_FILES,
  mergeKeyFromName,
  mergeToken,
  updateField,
  updateFieldInput,
  type CreateFieldInput,
  type CustomField,
  type DocumentFormat,
  type FieldDefinition,
  type FieldFolder,
  type UpdateFieldInput,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useId, useRef, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from './api';
import {
  fieldKinds,
  formatNames,
  kindOf,
  placeholderTypes,
  typeOfKind,
  useFieldTypeNames,
  type FieldKind,
} from './custom-field-words';
import { issuesOf, noRejection, rejection, type Rejection } from './problems';
import { FormProblem, isStale, returnTo, savingProblem } from './settings-list';
import { fieldDraftReady, hasOptions, isChoiceType } from './settings-rules';
import { useBusiness } from './workspace';

type Option = FieldDefinition['options'][number];
type Overwrite = FieldDefinition['aiOverwrite'];
const overwrites: readonly Overwrite[] = ['ask', 'never', 'allow'];

const sectionHeadingClassName = 'text-base font-medium text-foreground';
const checkboxClassName = 'size-[18px] accent-primary';

export interface FieldPanelProps {
  /** The field to edit, or undefined for a new one. */
  readonly field: CustomField | undefined;
  readonly objects: readonly { readonly key: string; readonly label: string }[];
  /** Every object's folders. */
  readonly folders: readonly FieldFolder[];
  /** The object a new field starts on: the one the page is showing, if it shows one. */
  readonly startObject: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (created: boolean) => Promise<void>;
  /** The saved version, to edit in place of the one someone else has since changed. */
  readonly onReload: (latest: CustomField) => void;
}

export default function FieldPanel({
  field,
  objects,
  folders,
  startObject,
  returnFocus,
  onClose,
  onSaved,
  onReload,
}: FieldPanelProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const typeNames = useFieldTypeNames();
  const creating = field === undefined;
  const [kind, setKind] = useState<FieldKind>(() => (field === undefined ? 'text' : kindOf(field)));
  const { valueType, display } = typeOfKind(kind);
  const [objectKey, setObjectKey] = useState(
    field?.objectKey ?? startObject ?? objects[0]?.key ?? 'contact',
  );
  const [label, setLabel] = useState(field?.label ?? '');
  const [typedKey, setTypedKey] = useState<string>();
  const [description, setDescription] = useState(field?.description ?? '');
  const [chosenFolder, setChosenFolder] = useState(field?.folderId);
  const [currency, setCurrency] = useState(field?.currency ?? '');
  const [placeholder, setPlaceholder] = useState(field?.placeholder ?? '');
  const [options, setOptions] = useState<readonly Option[]>(field?.options ?? []);
  const [sources, setSources] = useState(field?.aiFillSources ?? []);
  const [overwrite, setOverwrite] = useState<Overwrite>(field?.aiOverwrite ?? 'ask');
  const [archived, setArchived] = useState(field?.archived ?? false);
  // GoHighLevel's file upload field: the formats it takes, and one file or several.
  const [formats, setFormats] = useState<readonly DocumentFormat[]>(
    field?.files?.formats ?? documentFormats,
  );
  const [limit, setLimit] = useState(field?.files?.limit ?? 1);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [changed, setChanged] = useState(false);
  const [asking, setAsking] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const previewId = useId();

  // The key follows the name until someone types a key of their own. A saved field's never
  // changes.
  const key =
    field?.key ?? typedKey ?? (label.trim() === '' ? '' : mergeKeyFromName(label, 'field'));
  const objectFolders = folders.filter((each) => each.objectKey === objectKey);
  // A new field goes to the object's system folder unless another is chosen.
  const folderId =
    objectFolders.find((each) => each.id === chosenFolder)?.id ??
    objectFolders.find((each) => each.system)?.id;
  const choice = hasOptions(valueType);
  const boxes = valueType === 'text_list';
  const assisted = aiFillable(valueType);
  const hasPlaceholder = placeholderTypes.includes(valueType);
  const mergeKey = key === '' ? null : fieldMergeKey(objectKey, key);
  const token = mergeKey === null ? '' : mergeToken(mergeKey);
  const choiceAction = (isArchived: boolean, name: string) =>
    isArchived ? t`Restore ${name}` : t`Archive ${name}`;
  const ready = fieldDraftReady(
    { label, key, description, valueType, currency, options, formats },
    creating,
  );
  const touch = <Value,>(set: (value: Value) => void) => {
    return (value: Value) => {
      set(value);
      setChanged(true);
    };
  };

  const save = useMutation({
    mutationFn: (body: CreateFieldInput | UpdateFieldInput) =>
      'revision' in body
        ? api.request(updateField, { params: { fieldId: field?.id ?? '' }, body })
        : api.request(createField, { body }),
    onSuccess: () => onSaved(creating),
    onError: (error) => {
      setProblem(
        savingProblem(error, t`The field wasn't saved. Check your connection and try again.`),
      );
    },
  });
  const submit = () => {
    const editable = {
      label,
      description,
      options: choice ? options : [],
      aiFillSources: assisted ? sources : [],
      aiOverwrite: overwrite,
      archived,
      ...(folderId === undefined ? {} : { folderId }),
      ...(hasPlaceholder ? { placeholder } : {}),
      ...(valueType === 'file' ? { files: { formats: [...formats], limit } } : {}),
    };
    // The API's own schema checks the form first, so the messages are the server's.
    const parsed =
      field === undefined
        ? createFieldInput.safeParse({
            ...editable,
            objectKey,
            key,
            valueType,
            ...(display === undefined ? {} : { display }),
            currency: valueType === 'money' ? currency : null,
          })
        : updateFieldInput.safeParse({ ...editable, revision: field.revision });
    if (parsed.success) {
      setProblem(noRejection);
      save.mutate(parsed.data);
    } else setProblem(rejection(issuesOf(parsed.error)));
  };
  const reload = useMutation({
    mutationFn: async () => {
      const latest = (await api.request(getFields, {})).items.find((each) => each.id === field?.id);
      if (latest === undefined || field === undefined) throw new Error('The field is gone.');
      const folder = folders.find((each) => each.id === latest.folderId);
      // The list's own shape: what a field's answer may leave out is as it was listed.
      return {
        ...field,
        ...latest,
        folderId: latest.folderId ?? field.folderId,
        folderName: folder?.name ?? field.folderName,
        placeholder: latest.placeholder ?? field.placeholder,
        mergeKey: latest.mergeKey ?? field.mergeKey,
        createdAt: latest.createdAt ?? field.createdAt,
        source: latest.source ?? field.source,
      };
    },
    onSuccess: onReload,
    onError: () => {
      setProblem({ fields: {}, form: t`The saved version couldn't be loaded. Try again.` });
    },
  });

  // Unsaved changes are not carried to another page, or lost to a reload, without asking.
  const unsaved = changed && !save.isSuccess;
  const blocker = useBlocker({
    shouldBlockFn: () => unsaved,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  });
  const leaving = asking || blocker.status === 'blocked';
  const sourceNames = {
    conversations: t`Conversations`,
    forms: t`Forms`,
    call_notes: t`Call notes`,
  };
  const overwriteNames: Readonly<Record<Overwrite, string>> = {
    ask: t`Ask me first`,
    never: t`Never overwrite`,
    allow: t`Allow changes`,
  };
  const nameLength = label.length;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (next) return;
        if (unsaved) setAsking(true);
        else onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-y-0 right-0 z-60 flex w-[min(960px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-5 pt-[max(16px,env(safe-area-inset-top))] pb-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-lg font-medium wrap-anywhere">
                {creating ? <Trans>Create custom field</Trans> : <Trans>Edit custom field</Trans>}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                <Trans>Customize your field's details and see a live preview.</Trans>
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
          <Form<Record<string, unknown>>
            className="min-h-0 flex-1 gap-0"
            errors={problem.fields}
            onFormSubmit={submit}
          >
            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto overscroll-contain lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="flex min-w-0 flex-col gap-4 px-5 py-4">
                <h3 className={sectionHeadingClassName}>
                  <Trans>Field details</Trans>
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    <Trans>Field type</Trans>
                    <Select
                      aria-label={t`Field type`}
                      disabled={!creating}
                      value={kind}
                      onValueChange={(next) => {
                        const chosen = fieldKinds.find((each) => each === next);
                        if (chosen !== undefined) touch(setKind)(chosen);
                      }}
                    >
                      {fieldKinds.map((each) => (
                        <option key={each} value={each}>
                          {typeNames[each]}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    <Trans>Add to object</Trans>
                    <Select
                      aria-label={t`Add to object`}
                      disabled={!creating}
                      value={objectKey}
                      onValueChange={touch(setObjectKey)}
                    >
                      {objects.map((each) => (
                        <option key={each.key} value={each.key}>
                          {each.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <Field name="label">
                    <FieldLabel>
                      <Trans>Field name</Trans>
                    </FieldLabel>
                    <Input
                      required
                      maxLength={80}
                      autoComplete="off"
                      placeholder={t`Enter name`}
                      value={label}
                      onChange={(event) => {
                        touch(setLabel)(event.target.value);
                      }}
                    />
                    <FieldDescription>
                      <Trans>{nameLength} of 80 characters</Trans>
                    </FieldDescription>
                    <FieldError />
                  </Field>
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    <Trans>Folder name</Trans>
                    <Select
                      aria-label={t`Folder name`}
                      value={folderId ?? ''}
                      onValueChange={touch(setChosenFolder)}
                    >
                      {objectFolders.map((each) => (
                        <option key={each.id} value={each.id}>
                          {each.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
                <Field name="key">
                  <FieldLabel>
                    <Trans>Key</Trans>
                  </FieldLabel>
                  <Input
                    disabled={!creating}
                    maxLength={63}
                    autoComplete="off"
                    className="font-mono"
                    value={key}
                    onChange={(event) => {
                      touch(setTypedKey)(event.target.value);
                    }}
                  />
                  <FieldDescription>
                    {mergeKey === null ? (
                      <Trans>Set once. Renaming the field keeps this key.</Trans>
                    ) : (
                      <Trans>
                        Set once. Renaming the field keeps this key. In a message:{' '}
                        <code className="font-mono text-xs">{token}</code>
                      </Trans>
                    )}
                  </FieldDescription>
                  <FieldError />
                </Field>
                <Field name="description">
                  <FieldLabel>
                    <Trans>What it means</Trans>
                  </FieldLabel>
                  <Textarea
                    required
                    rows={3}
                    maxLength={2000}
                    value={description}
                    onChange={(event) => {
                      touch(setDescription)(event.target.value);
                    }}
                  />
                  <FieldDescription>
                    <Trans>
                      The assistant reads this to decide what belongs here. Explain it as you would
                      to a new team member.
                    </Trans>
                  </FieldDescription>
                  <FieldError />
                </Field>
                {valueType === 'money' || choice || hasPlaceholder || valueType === 'file' ? (
                  <h3 className={sectionHeadingClassName}>
                    <Trans>Field options</Trans>
                  </h3>
                ) : null}
                {valueType === 'money' ? (
                  <Field name="currency">
                    <FieldLabel>
                      <Trans>Currency</Trans>
                    </FieldLabel>
                    <Input
                      disabled={!creating}
                      maxLength={3}
                      autoComplete="off"
                      className="sm:max-w-40"
                      value={currency}
                      onChange={(event) => {
                        touch(setCurrency)(event.target.value.toUpperCase());
                      }}
                    />
                    <FieldDescription>
                      <Trans>Use a three-letter currency code, such as KES.</Trans>
                    </FieldDescription>
                    <FieldError />
                  </Field>
                ) : null}
                {hasPlaceholder ? (
                  <Field name="placeholder">
                    <FieldLabel>
                      <Trans>Placeholder text</Trans>
                    </FieldLabel>
                    <Input
                      maxLength={200}
                      autoComplete="off"
                      value={placeholder}
                      onChange={(event) => {
                        touch(setPlaceholder)(event.target.value);
                      }}
                    />
                    <FieldDescription>
                      <Trans>A hint the empty field shows. It is never saved as a value.</Trans>
                    </FieldDescription>
                    <FieldError />
                  </Field>
                ) : null}
                {choice ? (
                  <fieldset className="flex min-w-0 flex-col gap-3">
                    <legend className="mb-2 text-sm font-medium">
                      {boxes ? <Trans>Text boxes</Trans> : <Trans>Choices</Trans>}
                    </legend>
                    {options.map((option, index) => (
                      <div
                        key={option.key}
                        className="flex flex-wrap items-end gap-2 rounded-control border p-3"
                      >
                        <label
                          htmlFor={`${option.key}-name`}
                          className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm"
                        >
                          {boxes ? <Trans>Box name</Trans> : <Trans>Choice name</Trans>}
                          <Input
                            id={`${option.key}-name`}
                            value={option.label}
                            maxLength={80}
                            onChange={(event) => {
                              touch(setOptions)(
                                options.map((old, at) =>
                                  at === index ? { ...old, label: event.target.value } : old,
                                ),
                              );
                            }}
                          />
                        </label>
                        <label
                          htmlFor={`${option.key}-description`}
                          className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm"
                        >
                          {boxes ? (
                            <Trans>Box description</Trans>
                          ) : (
                            <Trans>Choice description</Trans>
                          )}
                          <Input
                            id={`${option.key}-description`}
                            value={option.description}
                            maxLength={2000}
                            onChange={(event) => {
                              touch(setOptions)(
                                options.map((old, at) =>
                                  at === index ? { ...old, description: event.target.value } : old,
                                ),
                              );
                            }}
                          />
                        </label>
                        <Button
                          variant="quiet"
                          aria-label={choiceAction(option.archived, option.label)}
                          onClick={() => {
                            touch(setOptions)(
                              options.map((old, at) =>
                                at === index ? { ...old, archived: !old.archived } : old,
                              ),
                            );
                          }}
                        >
                          {option.archived ? t`Restore` : t`Archive`}
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="secondary"
                      className="self-start"
                      onClick={() => {
                        touch(setOptions)([
                          ...options,
                          {
                            key: `opt_${crypto.randomUUID().replaceAll('-', '')}`,
                            label: '',
                            description: '',
                            archived: false,
                          },
                        ]);
                      }}
                    >
                      {boxes ? <Trans>Add text box</Trans> : <Trans>Add choice</Trans>}
                    </Button>
                    {problem.fields['options'] === undefined ? null : (
                      <p role="alert" className="text-sm text-destructive">
                        {problem.fields['options']}
                      </p>
                    )}
                  </fieldset>
                ) : null}
                {valueType === 'file' ? (
                  <FileOptions
                    formats={formats}
                    limit={limit}
                    onFormats={touch(setFormats)}
                    onLimit={touch(setLimit)}
                    problem={problem.fields['files']}
                  />
                ) : null}
                {/* The assistant fills neither a text box list nor a file upload field. */}
                {assisted ? (
                  <>
                    <h3 className={sectionHeadingClassName}>
                      <Trans>Assistant</Trans>
                    </h3>
                    <fieldset>
                      <legend className="mb-2 text-sm font-medium">
                        <Trans>The assistant can fill this in from</Trans>
                      </legend>
                      <div className="flex flex-wrap gap-x-5 gap-y-2">
                        {fieldAiSources.map((source) => (
                          <label
                            key={source}
                            className="flex min-h-11 items-center gap-2 lg:min-h-9"
                          >
                            <input
                              type="checkbox"
                              checked={sources.includes(source)}
                              onChange={(event) => {
                                touch(setSources)(
                                  event.target.checked
                                    ? [...sources, source]
                                    : sources.filter((old) => old !== source),
                                );
                              }}
                              className={checkboxClassName}
                            />
                            {sourceNames[source]}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <label className="flex flex-col gap-1.5 text-sm font-medium">
                      <Trans>When the assistant changes a value someone typed</Trans>
                      <Select
                        aria-label={t`When the assistant changes a value someone typed`}
                        value={overwrite}
                        onValueChange={(next) => {
                          const policy = overwrites.find((each) => each === next);
                          if (policy !== undefined) touch(setOverwrite)(policy);
                        }}
                      >
                        {overwrites.map((each) => (
                          <option key={each} value={each}>
                            {overwriteNames[each]}
                          </option>
                        ))}
                      </Select>
                    </label>
                  </>
                ) : null}
                {creating ? null : (
                  <label className="flex min-h-11 items-center gap-2 lg:min-h-9">
                    <input
                      type="checkbox"
                      checked={archived}
                      onChange={(event) => {
                        touch(setArchived)(event.target.checked);
                      }}
                      className={checkboxClassName}
                    />
                    <Trans>Archive field</Trans>
                  </label>
                )}
              </div>
              <aside
                aria-labelledby={previewId}
                className="flex min-w-0 flex-col gap-3 border-t bg-muted px-5 py-4 lg:border-t-0 lg:border-l"
              >
                <h3
                  id={previewId}
                  className="text-xs font-medium tracking-wide text-body uppercase"
                >
                  <Trans>Live preview</Trans>
                </h3>
                <FieldPreview
                  label={label.trim() === '' ? t`Field name` : label}
                  kind={kind}
                  formats={formats}
                  limit={limit}
                  placeholder={hasPlaceholder ? placeholder : ''}
                  currency={currency}
                  options={options.filter((each) => !each.archived && each.label.trim() !== '')}
                />
              </aside>
            </div>
            <div className="flex flex-col gap-3 border-t px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
              <FormProblem
                problem={problem}
                stale={isStale(save.error)}
                busy={reload.isPending}
                onReload={() => {
                  reload.mutate();
                }}
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Dialog.Close render={<Button variant="secondary" disabled={save.isPending} />}>
                  <Trans>Cancel</Trans>
                </Dialog.Close>
                <Button type="submit" disabled={!ready || save.isPending}>
                  {creating ? t`Create custom field` : t`Save changes`}
                </Button>
              </div>
            </div>
          </Form>
          <Dialog.Root
            open={leaving}
            onOpenChange={(next) => {
              if (next) return;
              setAsking(false);
              blocker.reset?.();
            }}
          >
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
              <Dialog.Popup
                // On the way that loses nothing.
                initialFocus={keepRef}
                className="fixed top-1/2 left-1/2 z-[65] flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none"
              >
                <div className="flex flex-col gap-1">
                  <Dialog.Title className="text-lg font-medium">
                    <Trans>You have unsaved changes</Trans>
                  </Dialog.Title>
                  <Dialog.Description className="text-md text-muted-foreground">
                    <Trans>Your changes to this field haven't been saved.</Trans>
                  </Dialog.Description>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    className="border-destructive text-destructive"
                    onClick={() => {
                      if (blocker.status === 'blocked') blocker.proceed();
                      else onClose();
                    }}
                  >
                    <Trans>Discard changes</Trans>
                  </Button>
                  <Button
                    ref={keepRef}
                    onClick={() => {
                      setAsking(false);
                      blocker.reset?.();
                    }}
                  >
                    <Trans>Keep editing</Trans>
                  </Button>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The field as it will appear on a record: its label, and an empty control of its type. */
function FieldPreview({
  label,
  kind,
  formats,
  limit,
  placeholder,
  currency,
  options,
}: {
  readonly label: string;
  readonly kind: FieldKind;
  readonly formats: readonly DocumentFormat[];
  readonly limit: number;
  readonly placeholder: string;
  readonly currency: string;
  readonly options: readonly Option[];
}): ReactElement {
  const { t } = useLingui();
  const previewLabel = t`Preview of ${label}`;
  const { valueType } = typeOfKind(kind);
  const accepted = formats.map((each) => formatNames[each]).join(', ');
  if (kind === 'radio' || kind === 'checkbox' || kind === 'text_list' || kind === 'file')
    return (
      <fieldset
        disabled
        className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-4"
      >
        <legend className="sr-only">{previewLabel}</legend>
        <span className="text-sm font-medium wrap-anywhere text-foreground">{label}</span>
        {kind === 'file' ? (
          <div className="flex flex-col items-center gap-1 rounded-control border border-dashed border-input px-3 py-5 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {limit === 1 ? (
                <Trans>Upload a file</Trans>
              ) : (
                <Trans>Upload up to {limit} files</Trans>
              )}
            </span>
            <span>{accepted}</span>
          </div>
        ) : options.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            {kind === 'text_list' ? <Trans>Add a text box.</Trans> : <Trans>Add a choice.</Trans>}
          </span>
        ) : kind === 'text_list' ? (
          options.map((option) => (
            <label key={option.key} className="flex flex-col gap-1 text-sm">
              {option.label}
              <Input />
            </label>
          ))
        ) : (
          options.map((option) => (
            <label key={option.key} className="flex min-h-9 items-center gap-2 text-sm text-body">
              <input
                type={kind === 'radio' ? 'radio' : 'checkbox'}
                name={previewLabel}
                className={checkboxClassName}
              />
              {option.label}
            </label>
          ))
        )}
      </fieldset>
    );
  const inputTypes: Partial<Record<FieldDefinition['valueType'], string>> = {
    number: 'number',
    date: 'date',
    datetime: 'datetime-local',
    email: 'email',
    phone: 'tel',
    url: 'url',
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-card border border-border bg-card p-4">
      <span className="text-sm font-medium wrap-anywhere text-foreground">{label}</span>
      {valueType === 'boolean' ? (
        <span className="flex items-center gap-2 text-sm text-body">
          <input type="checkbox" disabled aria-label={previewLabel} className={checkboxClassName} />
          <Trans>Yes</Trans>
        </span>
      ) : isChoiceType(valueType) ? (
        <>
          <Select aria-label={previewLabel} disabled value="">
            <option value="">
              {valueType === 'multi_choice' ? t`Choose one or more` : t`Choose one`}
            </option>
          </Select>
          {options.length === 0 ? null : (
            <ul className="flex flex-wrap gap-1.5">
              {options.map((option) => (
                <li
                  key={option.key}
                  className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                >
                  {option.label}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : valueType === 'long_text' ? (
        <textarea
          disabled
          rows={3}
          aria-label={previewLabel}
          placeholder={placeholder}
          className="w-full min-w-0 resize-none rounded-control border border-input bg-card px-3 py-2 text-md placeholder:text-muted-foreground disabled:opacity-50"
        />
      ) : (
        <span className="flex items-center gap-2">
          {valueType === 'money' && currency !== '' ? (
            <span className="text-sm text-body">{currency}</span>
          ) : null}
          <Input
            disabled
            type={inputTypes[valueType] ?? 'text'}
            aria-label={previewLabel}
            placeholder={placeholder}
          />
        </span>
      )}
    </div>
  );
}

/** What a file upload field takes: its formats, and one file or up to a number of them. */
function FileOptions({
  formats,
  limit,
  onFormats,
  onLimit,
  problem,
}: {
  readonly formats: readonly DocumentFormat[];
  readonly limit: number;
  readonly onFormats: (formats: readonly DocumentFormat[]) => void;
  readonly onLimit: (limit: number) => void;
  readonly problem: string | undefined;
}): ReactElement {
  const limitId = useId();
  const [limitText, setLimitText] = useState(String(limit));
  return (
    <>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">
          <Trans>Accepted formats</Trans>
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {documentFormats.map((format) => (
            <label key={format} className="flex min-h-11 items-center gap-2 lg:min-h-9">
              <input
                type="checkbox"
                checked={formats.includes(format)}
                onChange={(event) => {
                  onFormats(
                    event.target.checked
                      ? documentFormats.filter((each) => each === format || formats.includes(each))
                      : formats.filter((each) => each !== format),
                  );
                }}
                className={checkboxClassName}
              />
              {formatNames[format]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex min-h-11 items-center gap-2 lg:min-h-9">
        <input
          type="checkbox"
          checked={limit > 1}
          onChange={(event) => {
            const next = event.target.checked ? MAX_FIELD_FILES : 1;
            setLimitText(String(next));
            onLimit(next);
          }}
          className={checkboxClassName}
        />
        <Trans>Allow multiple files</Trans>
      </label>
      {limit > 1 ? (
        <label htmlFor={limitId} className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Most files on one record</Trans>
          <Input
            id={limitId}
            type="number"
            inputMode="numeric"
            min={2}
            max={MAX_FIELD_FILES}
            className="sm:max-w-40"
            value={limitText}
            // What is typed stays as typed; a whole number in range counts at once, and
            // anything else is brought into range when the box is left.
            onChange={(event) => {
              setLimitText(event.target.value);
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 2 && next <= MAX_FIELD_FILES) onLimit(next);
            }}
            onBlur={() => {
              const next = Number(limitText);
              const fitted = Number.isInteger(next)
                ? Math.min(MAX_FIELD_FILES, Math.max(2, next))
                : limit;
              setLimitText(String(fitted));
              onLimit(fitted);
            }}
          />
        </label>
      ) : null}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        <Trans>
          Each file is checked when it is uploaded: its name must end in one of these formats, and
          its content must be that format.
        </Trans>
      </p>
    </>
  );
}
