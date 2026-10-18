// What the tracking link builder works out before it draws: the platforms and their
// templates as the catalogue lists them (packages/contracts/src/tracking-links.ts), the
// text to paste for what was typed, built by the catalogue's own function, and the link as
// it would arrive from a click, with a sample value in place of each of the platform's
// placeholders, for "What this link will record". Nothing here names a parameter or a
// placeholder: every one is the catalogue's.
import {
  buildTrackingLink,
  defaultTrackingLinkTemplate,
  trackingLinkPlatforms,
  trackingLinkTemplate,
  trackingLinkTemplates,
  type BuiltTrackingLink,
  type TrackingLinkParameter,
  type TrackingLinkPlatform,
  type TrackingLinkTemplate,
} from '@repo/contracts';
import { addressOf } from '../forms-link-check-rules';

/** The platforms that have a template, in the catalogue's order. */
export const linkPlatforms: readonly TrackingLinkPlatform[] = trackingLinkPlatforms.filter(
  (platform) => trackingLinkTemplates.some((template) => template.platform === platform),
);

/** A platform's templates, the one offered first at the top. */
export const templatesOf = (platform: TrackingLinkPlatform): TrackingLinkTemplate[] =>
  trackingLinkTemplates
    .filter((template) => template.platform === platform)
    .toSorted((one, other) => Number(other.default) - Number(one.default));

/** The template a platform opens on. */
export const firstTemplateOf = (platform: TrackingLinkPlatform): TrackingLinkTemplate | undefined =>
  defaultTrackingLinkTemplate(platform) ?? templatesOf(platform)[0];

/** What the builder holds: a template, the landing page and the person's own words. */
export interface LinkDraft {
  readonly templateId: string;
  /** The landing page as typed. */
  readonly baseUrl: string;
  /** The person's own words, by parameter name. */
  readonly values: Readonly<Record<string, string>>;
}

export const linkDraftOf = (platform: TrackingLinkPlatform): LinkDraft => ({
  templateId: firstTemplateOf(platform)?.id ?? '',
  baseUrl: '',
  values: {},
});

/** The draft on another template: the landing page stays, and so do words the new one takes. */
export function withTemplate(draft: LinkDraft, templateId: string): LinkDraft {
  const editable = new Set(
    (trackingLinkTemplate(templateId)?.parameters ?? [])
      .filter((parameter) => parameter.editable)
      .map((parameter) => parameter.name),
  );
  return {
    templateId,
    baseUrl: draft.baseUrl,
    values: Object.fromEntries(Object.entries(draft.values).filter(([name]) => editable.has(name))),
  };
}

/** The parameters a person may put their own words in. */
export const editableParameters = (template: TrackingLinkTemplate): TrackingLinkParameter[] =>
  template.parameters.filter((parameter) => parameter.editable);

/** Whether the template's text is pasted beside the ad's own address, which is then not part of it. */
export const pastedBesideAddress = (template: TrackingLinkTemplate): boolean =>
  template.form !== 'link';

/** What to paste for the draft, built by the catalogue's own function. */
export function builtLink(draft: LinkDraft): BuiltTrackingLink {
  const template = trackingLinkTemplate(draft.templateId);
  // A suffix and a tracking template never hold the landing page: it is not asked of them.
  const base =
    template !== undefined && pastedBesideAddress(template) ? '' : addressOf(draft.baseUrl);
  return buildTrackingLink({
    templateId: draft.templateId,
    ...(base === '' ? {} : { baseUrl: base }),
    values: draft.values,
  });
}

/** The page a sample click lands on while no landing page was typed. */
export const SAMPLE_PAGE = 'https://www.example.com/';

/**
 * The address a click on the ad would arrive with: the landing page, then every parameter
 * as built, with the catalogue's sample value in place of each placeholder the platform
 * fills in. Undefined while the draft builds nothing or the landing page is not an address.
 */
export function arrivingLink(draft: LinkDraft): string | undefined {
  const template = trackingLinkTemplate(draft.templateId);
  if (template === undefined) return undefined;
  const typed = addressOf(draft.baseUrl);
  const base = typed === '' ? SAMPLE_PAGE : typed;
  if (!URL.canParse(base)) return undefined;
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  for (const parameter of template.parameters) {
    const own = parameter.editable ? (draft.values[parameter.name] ?? '').trim() : '';
    const value =
      own !== ''
        ? own
        : parameter.kind === 'placeholder'
          ? (template.sample[parameter.value] ?? '')
          : parameter.value;
    url.searchParams.set(parameter.name, value);
  }
  return url.href;
}

/** Whether the landing page typed is one a link can be built on; an empty box is no mistake. */
export function baseUrlProblem(draft: LinkDraft): boolean {
  const typed = addressOf(draft.baseUrl);
  if (typed === '') return false;
  if (!URL.canParse(typed)) return true;
  const { protocol } = new URL(typed);
  return protocol !== 'https:' && protocol !== 'http:';
}
