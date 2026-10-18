// The steps of a CSV import, in a dialog that takes the whole window on a phone: upload the
// file, map its columns, choose what to do with rows whose contact exists and the tags to
// add, review the first rows as the import would apply them, and start. The server looks at
// the file (inspect) and tries it (preview); nothing is written until the import is
// started, and then the worker does the writing. Contacts only.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  getTagConfiguration,
  inspectImportFile,
  previewImport,
  startImport,
  uploadFile,
  type ContactImportAttribute,
  type ImportFileInspection,
  type ImportMode,
  type ImportPlanInput,
  type ImportPreview,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Select } from '@repo/ui/components/select';
import { cn } from '@repo/ui/lib/utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from './api';
import {
  choicesOf,
  csvUpload,
  isCsvName,
  mappingOf,
  takenBy,
  type ColumnChoice,
} from './import-rules';
import {
  cellClassName,
  headerCellClassName,
  returnTo,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { useBusiness } from './workspace';

const steps = ['upload', 'map', 'options', 'review'] as const;
type Step = (typeof steps)[number];

const SKIP = 'skip';

// The API has no mode of its own to fall back on: the form starts on the first of these.
const modeOrder: readonly ImportMode[] = ['create_and_update', 'create', 'update'];

/** What the API said was wrong, each line as it gave it: a file's fault, a mapping's. */
function problemsOf(error: unknown, fallback: string): string[] {
  if (!(error instanceof ApiError)) return [fallback];
  const issues = error.problem.errors?.map((issue) => issue.message) ?? [];
  return issues.length > 0 ? [...new Set(issues)] : [error.problem.detail ?? fallback];
}

function Problems({ lines }: { readonly lines: readonly string[] }): ReactElement | null {
  return lines.length === 0 ? null : (
    <div role="alert" className="flex flex-col gap-1 text-sm font-medium text-destructive">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

const outcomeClassNames = {
  create: cn('border-success-line bg-success-subtle text-success'),
  update: cn('border-transparent bg-accent text-link'),
  skip: cn('border-transparent bg-secondary text-secondary-foreground'),
  fail: cn('border-transparent bg-secondary text-destructive'),
} as const;

export interface ImportFlowProps {
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onStarted: () => Promise<void>;
}

export default function ImportFlow({
  returnFocus,
  onClose,
  onStarted,
}: ImportFlowProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const fileInputId = useId();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File>();
  const [inspection, setInspection] = useState<ImportFileInspection>();
  const [choices, setChoices] = useState<readonly ColumnChoice[]>([]);
  const [mode, setMode] = useState<ImportMode>('create_and_update');
  const [tagIds, setTagIds] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<ImportPreview>();

  const tags = useQuery({
    queryKey: ['b', business.id, 'tags'],
    queryFn: () => api.request(getTagConfiguration, {}),
    enabled: step === 'options',
  });

  const plan = (): ImportPlanInput | undefined =>
    inspection === undefined
      ? undefined
      : {
          fileId: inspection.file.id,
          object: 'contact',
          mode,
          mapping: mappingOf(choices, inspection),
          delimiter: inspection.delimiter,
          tagIds: [...tagIds],
        };

  const inspect = useMutation({
    mutationFn: async (chosen: File) => {
      const stored = await api.request(uploadFile, {
        query: { filename: chosen.name },
        upload: csvUpload(chosen),
      });
      return api.request(inspectImportFile, { body: { fileId: stored.id, object: 'contact' } });
    },
    onSuccess: (found) => {
      setInspection(found);
      setChoices(choicesOf(found));
      setTagIds([]);
      setPreview(undefined);
      setStep('map');
    },
  });
  const review = useMutation({
    mutationFn: async () => {
      const body = plan();
      if (body === undefined) throw new Error('No file to preview.');
      return api.request(previewImport, { body });
    },
    onSuccess: (found) => {
      setPreview(found);
      setStep('review');
    },
  });
  const start = useMutation({
    mutationFn: async () => {
      const body = plan();
      if (body === undefined) throw new Error('No file to import.');
      return api.request(startImport, { body });
    },
    onSuccess: onStarted,
  });

  const stepNames: Readonly<Record<Step, string>> = {
    upload: t`Upload`,
    map: t`Map columns`,
    options: t`Options`,
    review: t`Review`,
  };
  const attributeNames: Readonly<Record<ContactImportAttribute, string>> = {
    firstName: t`First name`,
    lastName: t`Last name`,
    email: t`Email`,
    additionalEmails: t`Additional emails`,
    phone: t`Phone`,
    additionalPhones: t`Additional phones`,
    timeZone: t`Time zone`,
    doNotContact: t`Do not contact`,
    tags: t`Tags`,
  };
  const modeNames: Readonly<Record<ImportMode, { title: string; hint: string }>> = {
    create_and_update: {
      title: t`Create new contacts and update existing ones`,
      hint: t`Chosen to start with. Every row is used.`,
    },
    create: {
      title: t`Only create new contacts`,
      hint: t`A row whose contact already exists is skipped.`,
    },
    update: {
      title: t`Only update existing contacts`,
      hint: t`A row with no contact yet is skipped.`,
    },
  };
  const outcomeNames = {
    create: t`Create`,
    update: t`Update`,
    skip: t`Skip`,
    fail: t`Fail`,
  } as const;
  const mapped = inspection === undefined ? 0 : mappingOf(choices, inspection).length;
  const targetName = (choice: ColumnChoice): string => {
    const attribute = inspection?.attributes.find((each) => `attribute:${each}` === choice);
    if (attribute !== undefined) return attributeNames[attribute];
    return inspection?.fields.find((each) => `field:${each.id}` === choice)?.label ?? '';
  };
  const headerOf = (column: number): string =>
    inspection?.columns.find((each) => each.index === column)?.header ?? '';
  const shown = (value: string | boolean | readonly string[] | null): string =>
    value === null
      ? ''
      : typeof value === 'boolean'
        ? value
          ? t`Yes`
          : t`No`
        : typeof value === 'string'
          ? value
          : value.join(', ');
  const tagLimit = inspection?.limits.tags ?? 0;
  const wrongType = file !== undefined && !isCsvName(file.name);
  const current = steps.indexOf(step);
  const rowCount = inspection?.rowCount ?? 0;
  const fileName = inspection?.file.filename ?? '';
  const previewCount = preview?.rows.length ?? 0;

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
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-0 z-60 flex flex-col bg-card text-card-foreground outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(820px,calc(100dvh-48px))] sm:w-[min(1080px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-card sm:shadow-xl"
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-5 pt-[max(16px,env(safe-area-inset-top))] pb-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-lg font-medium">
                <Trans>Import contacts from CSV</Trans>
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                <Trans>Nothing is written until you start the import.</Trans>
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
          <ol
            aria-label={t`Steps`}
            className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 border-b px-5 py-2.5 text-sm"
          >
            {steps.map((each, at) => (
              <li
                key={each}
                aria-current={each === step ? 'step' : undefined}
                className="flex items-center gap-2 text-body aria-[current=step]:font-medium aria-[current=step]:text-link"
              >
                <span
                  aria-hidden
                  className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${at <= current ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}
                >
                  {at + 1}
                </span>
                {stepNames[each]}
              </li>
            ))}
          </ol>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4">
            {step === 'upload' ? (
              <>
                <h3 className="text-base font-medium text-foreground">
                  <Trans>Upload your file</Trans>
                </h3>
                <p className="text-sm text-body">
                  <Trans>A CSV file saved as UTF-8, with the column names in its first row.</Trans>
                </p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={fileInputId} className="text-sm font-medium">
                    <Trans>CSV file</Trans>
                  </label>
                  <input
                    id={fileInputId}
                    type="file"
                    accept=".csv,text/csv"
                    className="min-h-11 w-full max-w-xl rounded-control border border-input bg-card p-2 text-md text-foreground file:mr-3 file:rounded-control file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
                    onChange={(event) => {
                      setFile(event.target.files?.[0]);
                      inspect.reset();
                    }}
                  />
                </div>
                {wrongType ? (
                  <Problems lines={[t`Choose a file whose name ends in .csv.`]} />
                ) : inspect.isError ? (
                  <Problems
                    lines={problemsOf(
                      inspect.error,
                      t`The file couldn't be uploaded. Check your connection and try again.`,
                    )}
                  />
                ) : null}
              </>
            ) : null}
            {step === 'map' && inspection !== undefined ? (
              <>
                <h3 className="text-base font-medium text-foreground">
                  <Trans>Map columns</Trans>
                </h3>
                <p className="text-sm text-body">
                  <Plural
                    value={rowCount}
                    one={`# row found in ${fileName}.`}
                    other={`# rows found in ${fileName}.`}
                  />{' '}
                  <Trans>
                    Choose what each column fills. The suggestions come from the column names; a
                    column set to "Don't import" is left out.
                  </Trans>
                </p>
                <div
                  role="region"
                  aria-label={t`Columns of the file`}
                  className={tableRegionClassName}
                >
                  <table className={`${tableClassName} min-w-[640px]`}>
                    <caption className="sr-only">
                      <Trans>Columns of the file</Trans>
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col" className={headerCellClassName}>
                          <Trans>Column in the file</Trans>
                        </th>
                        <th scope="col" className={headerCellClassName}>
                          <Trans>Examples</Trans>
                        </th>
                        <th scope="col" className={`${headerCellClassName} w-64`}>
                          <Trans>Fills</Trans>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspection.columns.map((column, at) => {
                        const choice = choices[at] ?? '';
                        const header = column.header;
                        return (
                          <tr key={column.index}>
                            <th
                              scope="row"
                              className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                            >
                              {header}
                            </th>
                            <td className={`${cellClassName} max-w-72 truncate`}>
                              {column.samples.join(' · ')}
                            </td>
                            <td className={cellClassName}>
                              <Select
                                aria-label={t`What ${header} fills`}
                                value={choice === '' ? SKIP : choice}
                                onValueChange={(next) => {
                                  setChoices(
                                    choices.map((old, index) =>
                                      index === at ? (next === SKIP ? '' : next) : old,
                                    ),
                                  );
                                }}
                              >
                                <option value={SKIP}>{t`Don't import`}</option>
                                {inspection.attributes.map((attribute) => (
                                  <option
                                    key={attribute}
                                    value={`attribute:${attribute}`}
                                    disabled={takenBy(choices, `attribute:${attribute}`, at)}
                                  >
                                    {attributeNames[attribute]}
                                  </option>
                                ))}
                                {inspection.fields.map((field) => (
                                  <option
                                    key={field.id}
                                    value={`field:${field.id}`}
                                    disabled={takenBy(choices, `field:${field.id}`, at)}
                                  >
                                    {field.label}
                                  </option>
                                ))}
                              </Select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            {step === 'options' && inspection !== undefined ? (
              <>
                <h3 className="text-base font-medium text-foreground">
                  <Trans>Options</Trans>
                </h3>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-sm font-medium">
                    <Trans>
                      When a row's email address or phone number already belongs to a contact
                    </Trans>
                  </legend>
                  {modeOrder.map((each) => (
                    <div
                      key={each}
                      className="flex flex-col gap-0.5 rounded-control border border-border p-3 has-checked:border-primary has-checked:bg-accent"
                    >
                      <label className="flex min-h-6 items-center gap-3 text-sm font-medium text-foreground">
                        <input
                          type="radio"
                          name="import-mode"
                          className="size-[18px] shrink-0 accent-primary"
                          aria-describedby={`${fileInputId}-${each}`}
                          checked={mode === each}
                          onChange={() => {
                            setMode(each);
                          }}
                        />
                        {modeNames[each].title}
                      </label>
                      <p id={`${fileInputId}-${each}`} className="pl-[30px] text-sm text-body">
                        {modeNames[each].hint}
                      </p>
                    </div>
                  ))}
                  <p className="text-sm text-body">
                    <Trans>
                      Whichever you choose, no second contact is made for an address a contact
                      already holds.
                    </Trans>
                  </p>
                </fieldset>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-sm font-medium">
                    <Trans>Tags to add to every imported contact (optional)</Trans>
                  </legend>
                  {tags.isPending ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      <Trans>Loading the tags…</Trans>
                    </p>
                  ) : null}
                  {tags.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      <Trans>The tags couldn't be loaded. The import can go on without them.</Trans>
                    </p>
                  ) : null}
                  {tags.data?.items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      <Trans>There are no tags yet. Tags are made in Settings, under Tags.</Trans>
                    </p>
                  ) : null}
                  {tags.data === undefined || tags.data.items.length === 0 ? null : (
                    <div className="flex max-h-48 flex-wrap gap-x-5 gap-y-1 overflow-y-auto">
                      {tags.data.items.map((tag) => {
                        const checked = tagIds.includes(tag.id);
                        return (
                          <label
                            key={tag.id}
                            className="flex min-h-11 items-center gap-2 lg:min-h-9"
                          >
                            <input
                              type="checkbox"
                              className="size-[18px] accent-primary"
                              checked={checked}
                              disabled={!checked && tagIds.length >= tagLimit}
                              onChange={(event) => {
                                setTagIds(
                                  event.target.checked
                                    ? [...tagIds, tag.id]
                                    : tagIds.filter((old) => old !== tag.id),
                                );
                              }}
                            />
                            {tag.name}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </fieldset>
                <p className="text-sm text-body">
                  <Trans>
                    Importing gives no one consent to be messaged: an imported contact has the
                    consent it had before, which for a new contact is none.
                  </Trans>
                </p>
                {review.isError ? (
                  <Problems
                    lines={problemsOf(
                      review.error,
                      t`The file couldn't be reviewed. Check your connection and try again.`,
                    )}
                  />
                ) : null}
              </>
            ) : null}
            {step === 'review' && preview !== undefined ? (
              <>
                <h3 className="text-base font-medium text-foreground">
                  <Trans>Review</Trans>
                </h3>
                <p className="text-sm text-body">
                  <Plural
                    value={previewCount}
                    one="The first row as the import would apply it now."
                    other="The first # rows as the import would apply them now."
                  />{' '}
                  <Plural
                    value={rowCount}
                    one="The file holds # row."
                    other="The file holds # rows."
                  />{' '}
                  <Trans>
                    Nothing has been written. A row may come out differently if contacts change
                    before the import runs.
                  </Trans>
                </p>
                <div
                  role="region"
                  aria-label={t`Review of the first rows`}
                  className={tableRegionClassName}
                >
                  <table className={`${tableClassName} table-fixed`}>
                    <caption className="sr-only">
                      <Trans>Review of the first rows</Trans>
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col" className={`${headerCellClassName} w-14`}>
                          <Trans>Row</Trans>
                        </th>
                        <th scope="col" className={`${headerCellClassName} w-24`}>
                          <Trans>Outcome</Trans>
                        </th>
                        <th scope="col" className={headerCellClassName}>
                          <Trans>Values and problems</Trans>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.row}>
                          <th scope="row" className={`${cellClassName} text-left font-normal`}>
                            {row.row}
                          </th>
                          <td className={cellClassName}>
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${outcomeClassNames[row.outcome]}`}
                            >
                              {outcomeNames[row.outcome]}
                            </span>
                          </td>
                          <td className={`${cellClassName} wrap-anywhere`}>
                            <p>
                              {row.values
                                .filter((value) => value.value !== null)
                                .map((value) => `${headerOf(value.column)}: ${shown(value.value)}`)
                                .join(' · ')}
                            </p>
                            {row.issues.map((issue) => (
                              <p
                                key={`${String(issue.column)}:${issue.code}`}
                                className="font-medium text-destructive"
                              >
                                {issue.column === null ? null : `${headerOf(issue.column)}: `}
                                {issue.message}
                              </p>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-body">
                  <dt className="font-medium text-foreground">
                    <Trans>Existing contacts</Trans>
                  </dt>
                  <dd>{modeNames[mode].title}</dd>
                  <dt className="font-medium text-foreground">
                    <Trans>Columns imported</Trans>
                  </dt>
                  <dd>
                    {choices
                      .filter((choice) => choice !== '')
                      .map(targetName)
                      .join(', ')}
                  </dd>
                </dl>
                {start.isError ? (
                  <Problems
                    lines={problemsOf(
                      start.error,
                      t`The import wasn't started. Check your connection and try again.`,
                    )}
                  />
                ) : null}
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            <Dialog.Close render={<Button variant="secondary" />}>
              <Trans>Cancel</Trans>
            </Dialog.Close>
            <div className="flex flex-wrap gap-2">
              {step === 'upload' ? null : (
                <Button
                  variant="secondary"
                  disabled={review.isPending || start.isPending}
                  onClick={() => {
                    review.reset();
                    start.reset();
                    setStep(steps[current - 1] ?? 'upload');
                  }}
                >
                  <Trans>Back</Trans>
                </Button>
              )}
              {step === 'upload' ? (
                <Button
                  disabled={file === undefined || wrongType || inspect.isPending}
                  onClick={() => {
                    if (file !== undefined) inspect.mutate(file);
                  }}
                >
                  {inspect.isPending ? t`Reading the file…` : t`Continue`}
                </Button>
              ) : null}
              {step === 'map' ? (
                <Button
                  disabled={mapped === 0}
                  onClick={() => {
                    setStep('options');
                  }}
                >
                  <Trans>Continue</Trans>
                </Button>
              ) : null}
              {step === 'options' ? (
                <Button
                  disabled={review.isPending}
                  onClick={() => {
                    review.mutate();
                  }}
                >
                  {review.isPending ? t`Reviewing…` : t`Review`}
                </Button>
              ) : null}
              {step === 'review' ? (
                <Button
                  disabled={start.isPending}
                  onClick={() => {
                    start.mutate();
                  }}
                >
                  <Trans>Start import</Trans>
                </Button>
              ) : null}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
