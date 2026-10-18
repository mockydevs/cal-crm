// What is wrong with a page before it goes live: the checks publishing makes, and the
// warnings a page's editor shows. Pure: it reads a document and the facts about the site
// around it, and says each problem in a sentence a person can act on.
//
// A blocking problem is one a visitor would meet as something broken or missing: publishing
// is refused until it is fixed. A warning is something the page will not do yet; it is
// published anyway.
import type {
  PageAction,
  PageDocument,
  PageElement,
  PageSection,
  SitePageProblem,
} from '@repo/contracts';
import { pageElements, videoEmbedUrl } from '@repo/site-render';

/** What a page's checks need to know about its site. */
export interface PageFacts {
  readonly kind: 'funnel' | 'website';
  readonly role: 'control' | 'variation';
  /** Every step of the site, by public id. */
  readonly steps: ReadonlyMap<
    string,
    { readonly name: string; readonly path: string; readonly published: boolean }
  >;
  /** The step after this page's own, in a funnel that has one. */
  readonly nextStepId: string | undefined;
  /** The saved sections the page refers to that are still there, by public id. */
  readonly sections: ReadonlyMap<string, PageSection>;
  /**
   * The forms the page names that exist, by public id. Undefined on an install that shows
   * no public form: a form on a page could not be shown at all.
   */
  readonly forms:
    ReadonlyMap<string, { readonly key: string; readonly published: boolean }> | undefined;
  /**
   * The calendars the page names that exist, by public id: where each one's booking page
   * is and whether it would take a booking now. Undefined on an install that serves no
   * booking page: a calendar on a page would lead nowhere.
   */
  readonly calendars:
    ReadonlyMap<string, { readonly path: string; readonly bookable: boolean }> | undefined;
  /** What each merge field stands for: the business's custom values that say something. */
  readonly mergeValues: ReadonlyMap<string, string>;
  /** Which of the small page scripts this install has to send. */
  readonly scripts: { readonly countdown: boolean; readonly popup: boolean };
}

const MERGE_FIELDS = /\{\{([a-z][a-z0-9_.]{0,126})\}\}/g;

const blocking = (code: string, message: string, nodeId: string | null): SitePageProblem => ({
  code,
  message,
  nodeId,
  blocking: true,
});
const warning = (code: string, message: string, nodeId: string | null): SitePageProblem => ({
  code,
  message,
  nodeId,
  blocking: false,
});

/** The actions of an element: its own, and those of the links in its text. */
function actionsOf(node: PageElement): PageAction[] {
  const actions: PageAction[] = [];
  const text = (runs: readonly { readonly link?: PageAction | undefined }[]): void => {
    for (const run of runs) if (run.link !== undefined) actions.push(run.link);
  };
  if (node.type === 'headline' || node.type === 'sub_headline' || node.type === 'paragraph')
    text(node.props.text);
  if (node.type === 'bullet_list') node.props.items.forEach(text);
  if (node.type === 'image' || node.type === 'button') actions.push(node.props.action);
  return actions;
}

/** Every problem of a page, the blocking ones first, each once per element. */
export function pageProblems(document: PageDocument, facts: PageFacts): SitePageProblem[] {
  if (document.mode !== 'visual')
    return [
      blocking(
        'code_page',
        'Code pages cannot be published yet. Publish a page made in the visual builder.',
        null,
      ),
    ];
  const problems: SitePageProblem[] = [];
  for (const section of document.sections)
    if (section.type === 'saved_section' && !facts.sections.has(section.sectionId))
      problems.push(
        blocking(
          'missing_section',
          'A saved section this page uses was deleted. Remove it from the page.',
          section.id,
        ),
      );
  const elements = [...pageElements(document, facts.sections)];
  if (elements.length === 0)
    problems.push(
      blocking(
        'empty_page',
        'This page is empty. Add a section with some content before publishing.',
        null,
      ),
    );

  for (const node of elements) {
    const { id } = node;
    switch (node.type) {
      case 'image':
        if (node.props.src === null)
          problems.push(
            blocking(
              'image_missing',
              'An image has no picture chosen. Choose one or remove the image.',
              id,
            ),
          );
        else if (node.props.action.type !== 'none' && node.props.alt.trim() === '')
          problems.push(
            blocking(
              'image_alt',
              'An image that is a link needs alternative text, so people who cannot see it know where it goes.',
              id,
            ),
          );
        break;
      case 'video':
        if (node.props.url === null)
          problems.push(
            blocking('video_missing', 'A video has no address. Add one or remove the video.', id),
          );
        else if (node.props.source !== 'file' && videoEmbedUrl(node.props) === undefined)
          problems.push(
            blocking(
              'video_address',
              node.props.source === 'youtube'
                ? 'A video’s address is not a YouTube video. Paste the address of the video’s own page.'
                : 'A video’s address is not a Vimeo video. Paste the address of the video’s own page.',
              id,
            ),
          );
        break;
      case 'form': {
        const form = node.props.formId === null ? undefined : facts.forms?.get(node.props.formId);
        if (node.props.formId === null)
          problems.push(
            blocking(
              'form_missing',
              'A form element has no form chosen. Choose one or remove it.',
              id,
            ),
          );
        else if (facts.forms === undefined)
          problems.push(
            blocking(
              'form_unavailable',
              'Public forms are switched off on this install, so a form cannot be shown on a page.',
              id,
            ),
          );
        else if (form === undefined)
          problems.push(
            blocking(
              'form_gone',
              'The form on this page was deleted. Choose another or remove it.',
              id,
            ),
          );
        else if (!form.published)
          problems.push(
            blocking(
              'form_unpublished',
              'The form on this page is not published. Publish the form first.',
              id,
            ),
          );
        break;
      }
      case 'calendar': {
        const calendar =
          node.props.calendarId === null ? undefined : facts.calendars?.get(node.props.calendarId);
        if (node.props.calendarId === null)
          problems.push(
            blocking(
              'calendar_missing',
              'A calendar element has no calendar chosen. Choose one or remove it.',
              id,
            ),
          );
        else if (facts.calendars === undefined)
          problems.push(
            blocking(
              'calendar_unavailable',
              'Public booking pages are switched off on this install, so a calendar on a page would lead nowhere.',
              id,
            ),
          );
        else if (calendar === undefined)
          problems.push(
            blocking(
              'calendar_gone',
              'The calendar on this page was deleted. Choose another or remove it.',
              id,
            ),
          );
        else if (!calendar.bookable)
          problems.push(
            blocking(
              'calendar_inactive',
              'The calendar on this page cannot be booked yet. Switch it on in Calendars, with someone to book and a mailbox for confirmations, then publish.',
              id,
            ),
          );
        break;
      }
      case 'countdown':
        if (node.props.endsAt === null)
          problems.push(
            blocking('countdown_missing', 'A countdown has no end time. Set one or remove it.', id),
          );
        else if (!facts.scripts.countdown)
          problems.push(
            warning(
              'countdown_static',
              'This install was built without its countdown script, so the time left is shown as it was when the page was last loaded and does not tick.',
              id,
            ),
          );
        break;
      case 'custom_code':
        problems.push(
          warning(
            'custom_code_hidden',
            'Custom code is not shown on this address. It runs only on a connected domain.',
            id,
          ),
        );
        break;
      case 'headline':
      case 'sub_headline':
      case 'paragraph':
      case 'bullet_list':
      case 'button':
      case 'divider':
      case 'container':
        break;
    }
    const seen = new Set<string>();
    const once = (problem: SitePageProblem): void => {
      if (seen.has(problem.code)) return;
      seen.add(problem.code);
      problems.push(problem);
    };
    for (const action of actionsOf(node)) {
      if (action.type === 'step') {
        const step = facts.steps.get(action.stepId);
        if (step === undefined)
          once(blocking('missing_step', 'A link goes to a step this site no longer has.', id));
        else if (!step.published)
          once(
            warning(
              'unpublished_step',
              `A link goes to “${step.name}”, which is not published yet. Visitors cannot follow it until it is.`,
              id,
            ),
          );
      }
      if (action.type === 'next_step') {
        const next = facts.nextStepId === undefined ? undefined : facts.steps.get(facts.nextStepId);
        if (next === undefined)
          once(
            blocking(
              'no_next_step',
              facts.kind === 'website'
                ? 'A link goes to the next step, but a website’s pages have no order. Link to a page instead.'
                : 'A link goes to the next step, but this is the last step of the funnel.',
              id,
            ),
          );
        else if (!next.published)
          once(
            warning(
              'unpublished_step',
              `A link goes to “${next.name}”, which is not published yet. Visitors cannot follow it until it is.`,
              id,
            ),
          );
      }
    }
  }

  for (const popup of document.popups)
    if (popup.props.trigger !== 'none' && !facts.scripts.popup)
      problems.push(
        warning(
          'popup_trigger',
          `This install was built without its popup script, so the popup “${popup.name}” opens only from a link or a button, not by itself.`,
          popup.id,
        ),
      );
  if (document.settings.headCode.trim() !== '' || document.settings.bodyCode.trim() !== '')
    problems.push(
      warning(
        'page_code_hidden',
        'This page’s head and body code is not added on this address. It runs only on a connected domain.',
        null,
      ),
    );
  // A page fills a merge field with the business's custom value of that key. One with no
  // value shows nothing, which a visitor sees as a gap: said here, by name.
  const unfilled = [
    ...new Set(
      [...JSON.stringify([document, ...facts.sections.values()]).matchAll(MERGE_FIELDS)].flatMap(
        ([, key = '']) => (facts.mergeValues.has(key) ? [] : [key]),
      ),
    ),
  ].sort();
  if (unfilled.length > 0) {
    const named = unfilled
      .slice(0, 5)
      .map((key) => `{{${key}}}`)
      .join(', ');
    const more = unfilled.length > 5 ? ` and ${String(unfilled.length - 5)} more` : '';
    problems.push(
      warning(
        'merge_fields',
        `These merge fields have no value, so they show as nothing: ${named}${more}. A page fills in the business’s custom values (Settings, Custom values); a contact’s details are not known on a page.`,
        null,
      ),
    );
  }
  if (facts.role === 'variation')
    problems.push(
      warning(
        'variation_not_served',
        'Visitors are shown the control page. A variation is not shown to anyone until split tests are served.',
        null,
      ),
    );
  return [
    ...problems.filter((each) => each.blocking),
    ...problems.filter((each) => !each.blocking),
  ];
}
