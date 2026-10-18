import { FolderOpen, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createFileLink,
  getBusinessProfile,
  updateBusinessProfile,
  updateBusinessProfileInput,
  uploadFile,
  type BusinessProfile,
  type UpdateBusinessProfileInput,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Form } from '@repo/ui/components/form';
import { Input } from '@repo/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { issuesOf, noRejection, rejection, type Issue, type Rejection } from './problems';
import { Page } from './shell/page';
import { meQuery, useBusiness } from './workspace';

const addressFields = [
  { name: 'line1', label: msg`Street address`, autoComplete: 'address-line1' },
  { name: 'line2', label: msg`Address line 2`, autoComplete: 'address-line2' },
  { name: 'city', label: msg`City`, autoComplete: 'address-level2' },
  { name: 'region', label: msg`State or region`, autoComplete: 'address-level1' },
  { name: 'postalCode', label: msg`Postal code`, autoComplete: 'postal-code' },
  { name: 'country', label: msg`Country code`, autoComplete: 'country' },
] as const;
const fields = [
  { name: 'name', label: msg`Name`, maxLength: 200, autoComplete: 'organization' },
  { name: 'timezone', label: msg`Time zone`, maxLength: 100, autoComplete: 'off' },
  { name: 'locale', label: msg`Locale`, maxLength: 100, autoComplete: 'off' },
  { name: 'currency', label: msg`Currency`, maxLength: 3, autoComplete: 'off' },
] as const;
const fieldErrors = (issues: readonly Issue[]) =>
  rejection(issues.map((issue) => ({ ...issue, path: issue.path.replace(/^\/address\//, '/') })));

export function BusinessProfilePage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  const current = useQuery({
    queryKey: ['business-profile', business.id],
    queryFn: () => client.request(getBusinessProfile, {}),
  });
  return (
    <Page title={t`Business Profile`}>
      <p className="max-w-[760px] text-md leading-relaxed text-muted-foreground">
        <Trans>The name, address and local settings used for this business.</Trans>
      </p>
      {current.isPending ? (
        <p role="status">
          <Trans>Loading business profile…</Trans>
        </p>
      ) : null}
      {current.isError ? (
        <p role="alert">
          <Trans>We couldn't load the business profile.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void current.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </p>
      ) : null}
      {current.data === undefined ? null : (
        <ProfileForm key={business.id} profile={current.data} client={client} />
      )}
      <Suspense fallback={null}>
        <DuplicatePreferences key={business.id} />
      </Suspense>
    </Page>
  );
}

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// The media library in a dialog, loaded when it is first opened.
const MediaPicker = lazy(() => import('./media/picker'));
// Contact Deduplication Preferences, with its words, which are a catalog of their own.
const DuplicatePreferences = lazy(async () => {
  const [section, words] = await Promise.all([
    import('./contact-duplicates/preferences'),
    import('./contact-duplicates/words'),
  ]);
  await words.loadContactDuplicateWords();
  return section;
});

function ProfileForm({
  profile,
  client,
}: {
  readonly profile: BusinessProfile;
  readonly client: Client;
}): ReactElement {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const [notice, setNotice] = useState<string>();
  const [file, setFile] = useState<File>();
  const [logoFileId, setLogoFileId] = useState(profile.logoFileId);
  // A picture chosen from Media Storage: it is there already, so saving only names it.
  const [picked, setPicked] = useState<{ id: string; name: string; url: string | null }>();
  const [picking, setPicking] = useState(false);
  // The picture just chosen shows at once, from the browser's own copy of it.
  const chosenUrl = useMemo(
    () => (file === undefined ? undefined : URL.createObjectURL(file)),
    [file],
  );
  useEffect(
    () => () => {
      if (chosenUrl !== undefined) URL.revokeObjectURL(chosenUrl);
    },
    [chosenUrl],
  );
  const logo = useQuery({
    queryKey: ['business-logo', profile.id, profile.logoFileId],
    queryFn: () =>
      client.request(createFileLink, {
        params: { id: profile.logoFileId ?? '' },
        body: { expiresIn: 3600 },
      }),
    enabled: profile.logoFileId !== null && logoFileId !== null,
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });
  const shownLogo =
    chosenUrl ??
    (picked?.id === logoFileId
      ? (picked.url ?? undefined)
      : logoFileId !== null
        ? logo.data?.url
        : undefined);
  const megabytes = file === undefined ? '' : (file.size / 1_048_576).toFixed(1);
  const kilobytes = file === undefined ? '' : String(Math.max(1, Math.round(file.size / 1024)));
  const chosenSize =
    file !== undefined && file.size >= 1_048_576 ? t`${megabytes} MB` : t`${kilobytes} KB`;
  const save = useMutation({
    mutationFn: async (body: UpdateBusinessProfileInput) => {
      const uploaded =
        file === undefined
          ? undefined
          : await client.request(uploadFile, {
              query: { filename: file.name },
              upload: { content: file, type: file.type },
            });
      // Reuse an uploaded file if the following profile save fails and the user retries.
      if (uploaded !== undefined) {
        setLogoFileId(uploaded.id);
        setFile(undefined);
      }
      return client.request(updateBusinessProfile, {
        body: { ...body, logoFileId: uploaded?.id ?? body.logoFileId },
      });
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(['business-profile', profile.id], saved);
      setProblem(noRejection);
      setNotice(t`Business profile saved.`);
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.problem.errors !== undefined
          ? fieldErrors(error.problem.errors)
          : {
              fields: {},
              form:
                // A gateway's own error page is not words for a person: the server was away.
                error instanceof ApiError &&
                error.problem.status >= 502 &&
                error.problem.status <= 504
                  ? t`The server didn't answer just then, so nothing was saved. Wait a moment and save again: the picture you chose is still here.`
                  : error instanceof ApiError
                    ? error.message
                    : t`The profile wasn't saved. Check your connection and try again.`,
            },
      );
    },
  });
  return (
    <section
      aria-label={t`Business details`}
      className="rounded-card border border-border bg-card p-[22px]"
    >
      {!profile.canManage ? (
        <p className="mb-4 text-sm text-muted-foreground">
          <Trans>Only someone with permission can change this business profile.</Trans>
        </p>
      ) : null}
      <Form<Record<string, unknown>>
        errors={problem.fields}
        onFormSubmit={(values) => {
          setNotice(undefined);
          const address = Object.fromEntries(
            addressFields.map((field) => [field.name, values[field.name] ?? '']),
          );
          const parsed = updateBusinessProfileInput.safeParse({
            name: values['name'],
            timezone: values['timezone'],
            locale: values['locale'],
            currency: values['currency'],
            address: Object.values(address).every((value) => value === '') ? null : address,
            logoFileId,
          });
          if (!parsed.success) {
            setProblem(fieldErrors(issuesOf(parsed.error)));
            return;
          }
          setProblem(noRejection);
          save.mutate(parsed.data);
        }}
      >
        <fieldset
          disabled={!profile.canManage || save.isPending}
          className="flex min-w-0 flex-col gap-5"
        >
          <legend className="mb-4 text-lg font-semibold">
            <Trans>Business details</Trans>
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <Field key={field.name} name={field.name}>
                <FieldLabel>{i18n._(field.label)}</FieldLabel>
                <Input
                  defaultValue={profile[field.name]}
                  maxLength={field.maxLength}
                  autoComplete={field.autoComplete}
                  list={
                    field.name === 'timezone'
                      ? 'profile-timezones'
                      : field.name === 'currency'
                        ? 'profile-currencies'
                        : undefined
                  }
                />
                {field.name === 'locale' ? (
                  <FieldDescription>
                    <Trans>Language tag, such as en or en-KE.</Trans>
                  </FieldDescription>
                ) : null}
                <FieldError />
              </Field>
            ))}
          </div>
          <datalist id="profile-timezones">
            <option value="UTC" />
            {Intl.supportedValuesOf('timeZone').map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <datalist id="profile-currencies">
            {Intl.supportedValuesOf('currency').map((currency) => (
              <option key={currency} value={currency} />
            ))}
          </datalist>
          <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
            <legend className="mb-4 text-lg font-semibold">
              <Trans>Address</Trans>
            </legend>
            {addressFields.map((field) => (
              <Field key={field.name} name={field.name}>
                <FieldLabel>{i18n._(field.label)}</FieldLabel>
                <Input
                  defaultValue={profile.address?.[field.name] ?? ''}
                  autoComplete={field.autoComplete}
                  maxLength={field.name === 'country' ? 2 : field.name === 'postalCode' ? 32 : 200}
                />
                {field.name === 'country' ? (
                  <FieldDescription>
                    <Trans>Two-letter code, such as KE or US.</Trans>
                  </FieldDescription>
                ) : null}
                <FieldError />
              </Field>
            ))}
          </fieldset>
          <Field name="logoFileId">
            <FieldLabel nativeLabel htmlFor="business-logo">
              <Trans>Logo</Trans>
            </FieldLabel>
            {/* One clear box: what the logo is now, or the picture just chosen, and how to change it. */}
            <div className="flex min-w-0 flex-wrap items-center gap-4 rounded-card border border-dashed border-input bg-secondary/40 p-4">
              <span className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-card">
                {shownLogo === undefined ? (
                  <ImageIcon
                    aria-hidden
                    className="size-7 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                ) : (
                  <img
                    src={shownLogo}
                    alt={file === undefined ? t`Business logo` : t`The logo you chose`}
                    className="size-full object-contain"
                  />
                )}
              </span>
              <div className="flex min-w-0 flex-1 basis-56 flex-col gap-2">
                <p className="text-sm wrap-anywhere">
                  {file !== undefined ? (
                    <>
                      <span className="font-medium">{file.name}</span>{' '}
                      <span className="text-muted-foreground">
                        {t`${chosenSize}: uploaded when you save`}
                      </span>
                    </>
                  ) : picked?.id === logoFileId ? (
                    <>
                      <span className="font-medium">{picked.name}</span>{' '}
                      <span className="text-muted-foreground">
                        <Trans>from Media Storage: used when you save</Trans>
                      </span>
                    </>
                  ) : logoFileId !== null ? (
                    <Trans>This is your logo. Choose another picture to replace it.</Trans>
                  ) : (
                    <Trans>No logo yet. Choose a picture to add one.</Trans>
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="business-logo"
                    type="file"
                    accept={LOGO_TYPES.join(',')}
                    // Seen as the button beside it; still the control the label and keyboard reach.
                    className="peer sr-only"
                    onChange={(event) => {
                      setFile(event.target.files?.[0]);
                      setPicked(undefined);
                    }}
                  />
                  <label
                    htmlFor="business-logo"
                    className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border border-input bg-card px-3.5 text-sm font-medium text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50 hover:bg-muted lg:min-h-9"
                  >
                    <Upload aria-hidden className="size-4" strokeWidth={1.8} />
                    {logoFileId !== null || file !== undefined ? (
                      <Trans>Choose another picture</Trans>
                    ) : (
                      <Trans>Choose a picture</Trans>
                    )}
                  </label>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPicking(true);
                    }}
                  >
                    <FolderOpen aria-hidden className="size-4" strokeWidth={1.8} />
                    <Trans>Choose from Media Storage</Trans>
                  </Button>
                  {logoFileId !== null || file !== undefined ? (
                    <Button
                      variant="quiet"
                      size="small"
                      onClick={() => {
                        setLogoFileId(null);
                        setFile(undefined);
                        setPicked(undefined);
                      }}
                    >
                      <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                      <Trans>Remove logo</Trans>
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
            {logo.isError ? (
              <p className="text-sm">
                <Trans>The logo preview couldn't be loaded.</Trans>
              </p>
            ) : null}
            <FieldDescription>
              <Trans>
                PNG, JPEG, GIF or WebP. It appears on quotes, invoices and receipts. The file is
                uploaded when you save.
              </Trans>
            </FieldDescription>
            <FieldError />
          </Field>
          {problem.form === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem.form}
            </p>
          )}
          {profile.canManage ? (
            <Button type="submit" className="self-start" disabled={save.isPending}>
              {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
            </Button>
          ) : null}
        </fieldset>
        {notice === undefined ? null : (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </Form>
      {picking ? (
        <Suspense fallback={null}>
          <MediaPicker
            businessId={profile.id}
            title={<Trans>Choose a logo</Trans>}
            kinds={['image']}
            onChoose={(chosen) => {
              setPicked({ id: chosen.id, name: chosen.name, url: chosen.previewUrl });
              setLogoFileId(chosen.id);
              setFile(undefined);
              setPicking(false);
            }}
            onClose={() => {
              setPicking(false);
            }}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
