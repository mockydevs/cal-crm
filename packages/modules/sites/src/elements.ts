// What a published page does with each element type today, as the editor is told
// (listSitePageElements): the server's own word on it, so a screen never promises more
// than the renderer (packages/site-render) does.
import { pageElementTypes, type SitePageElementList } from '@repo/contracts';
import type { PageScripts } from '@repo/site-render';

type Info = SitePageElementList['items'][number];
type Note = Pick<Info, 'rendering' | 'script' | 'note'>;

const plain: Note = { rendering: 'static', script: false, note: null };

/**
 * Every element type of the format, in the order the element panel lists them, as this
 * install shows each: a countdown ticks only where the server has its script to send.
 */
export function sitePageElements(scripts: PageScripts | undefined): readonly Info[] {
  const notes: Readonly<Record<(typeof pageElementTypes)[number], Note>> = {
    headline: plain,
    sub_headline: plain,
    paragraph: plain,
    bullet_list: plain,
    image: plain,
    video: {
      rendering: 'embed',
      script: false,
      note: 'A YouTube or Vimeo video plays in its own player, in a frame. A YouTube video cannot be started muted.',
    },
    button: plain,
    divider: plain,
    form: {
      rendering: 'embed',
      script: true,
      note: 'Shown by the CRM’s own form script. The form must be published.',
    },
    calendar: {
      rendering: 'static',
      script: false,
      note: 'A link to the calendar’s own booking page, styled as a button. The calendar must be switched on and bookable.',
    },
    countdown:
      scripts?.countdown === undefined
        ? {
            rendering: 'static',
            script: false,
            note: 'Shows the time left as it was when the page was loaded, to the minute, and the moment it ends. This install was built without the script that makes it tick.',
          }
        : {
            rendering: 'static',
            script: true,
            note: 'Counts down each second with the CRM’s own small script, loaded only on a page that has a countdown. Without the script the page still shows the time left, to the minute, and the moment it ends.',
          },
    custom_code: {
      rendering: 'connected_domain',
      script: true,
      note: 'Never shown on this install’s own address. It runs only on a connected domain.',
    },
    container: plain,
  };
  return pageElementTypes.map((type) => ({ type, ...notes[type] }));
}
