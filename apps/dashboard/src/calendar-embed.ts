// The code a business pastes into its own website to show a calendar's booking page there,
// as GoHighLevel's calendar "Embed code": a frame of the booking page, and the CRM's small
// script that makes the frame as tall as the page.
//
// The frame's tag carries its height as an attribute as well as its look as a style: a
// website whose Content-Security-Policy refuses style attributes still shows the frame at
// that height, and the script sets the look and the height itself, as a script may.

/** The height the frame has before the script has measured the page, in CSS pixels. */
export const EMBED_HEIGHT = 860;

/** Where websites load the script from: the server's /calendars/embed.js. */
export const EMBED_SCRIPT_PATH = '/calendars/embed.js';

/** Text as an attribute's value in double quotes. */
function attribute(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * The embed code of a booking page: `address` is the page's full address, `origin` the
 * install's own, and `title` what a screen reader calls the frame.
 */
export function embedCode(address: string, origin: string, title: string): string {
  return [
    `<iframe src="${attribute(address)}" title="${attribute(title)}" data-crm-booking` +
      ` width="100%" height="${String(EMBED_HEIGHT)}" style="border:0;width:100%"` +
      ' loading="lazy"></iframe>',
    `<script async src="${attribute(origin)}${EMBED_SCRIPT_PATH}"></script>`,
  ].join('\n');
}
