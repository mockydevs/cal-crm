// What a page of a site may name as a picture, and what a file of Media Storage must be
// before a page can name it. A page is public and stays up for years, so a picture on it
// needs an address that anyone can open and that does not run out: a library file's public
// address, never its signed preview link. Nothing here reaches the network.

const MERGE_FIELD = /^\{\{[a-z][a-z0-9_.]{0,126}\}\}$/;
const NO_MARKUP = /^[^\s<>"'`\\]+$/;

/**
 * The page document's own rule for where a picture or a video is read from
 * (packages/contracts, sites-document.ts): a secure web address, a path on the site, or a
 * merge field. Said here to check an address while it is typed.
 */
export const isMediaAddress = (text: string): boolean =>
  text.length <= 2000 &&
  (MERGE_FIELD.test(text) || (/^(https:\/\/|\/(?!\/))/i.test(text) && NO_MARKUP.test(text)));

/** Where a link may go, by the same contract: also http, mail, a phone number, an anchor. */
export const isLinkAddress = (text: string): boolean =>
  text.length <= 2000 &&
  (MERGE_FIELD.test(text) ||
    (/^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(text) && NO_MARKUP.test(text)));

/** What stands between a library file and a page: nothing, or one of these. */
export type AddressRefusal =
  /** The file has no public address yet: it can be given one. */
  | 'private'
  /** Its public address is not a secure one, which a page does not take. */
  | 'insecure';

export type PageAddress =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly reason: AddressRefusal };

/**
 * The address a page may keep for a file of Media Storage. Only a public file has one; the
 * preview link is signed and runs out in an hour, so it is never used. An install that is
 * reached over plain http (a developer's machine) gives addresses a page refuses.
 */
export function pageAddressOf(file: {
  readonly public: boolean;
  readonly publicUrl: string | null;
}): PageAddress {
  if (!file.public || file.publicUrl === null) return { ok: false, reason: 'private' };
  return /^https:\/\//i.test(file.publicUrl) && isMediaAddress(file.publicUrl)
    ? { ok: true, address: file.publicUrl }
    : { ok: false, reason: 'insecure' };
}

/** The largest side a picture's stored size may have: the page document's own bound. */
export const MAX_PICTURE_SIDE = 20_000;

export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A picture's own size as a page keeps it, from what the browser measured: whole pixels,
 * each at least one. Null for a picture that did not load, one with no size of its own (an
 * SVG without one reports zero), or one larger than a page may say.
 */
export function pictureSize(natural: {
  readonly width: number;
  readonly height: number;
}): PictureSize | null {
  const width = Math.round(natural.width);
  const height = Math.round(natural.height);
  const whole = (side: number): boolean =>
    Number.isFinite(side) && side >= 1 && side <= MAX_PICTURE_SIDE;
  return whole(width) && whole(height) ? { width, height } : null;
}

/**
 * Whether an address is one the editor can load to measure: a full web address. A path on
 * the site has no site to be read from while a page is edited, and a merge field is filled
 * in when the page is published.
 */
export const isMeasurable = (address: string | null): address is string =>
  address !== null && /^https:\/\//i.test(address) && isMediaAddress(address);

/** The size stored for a picture, when the page has one for it: both sides, whole and positive. */
export function storedSize(props: Readonly<Record<string, unknown>>): PictureSize | null {
  const { width, height } = props;
  return typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1
    ? { width, height }
    : null;
}

/** Where a picture's description stands: said, owed, or not wanted. */
export type AltState =
  /** It has a description. */
  | 'described'
  /** Marked as decoration: it is passed over by a screen reader. */
  | 'decorative'
  /** It has neither: the person is asked for one or the other. */
  | 'owed'
  /** It is a link with no description, which the server refuses to publish. */
  | 'link_needs_words';

/**
 * A picture's description (an empty one means decoration). A picture that is a link always
 * needs words, since they say where the link goes; any other picture is either described or
 * marked as decoration by a person, never left empty unnoticed.
 */
export function altStateOf(input: {
  readonly alt: string;
  readonly isLink: boolean;
  /** Whether a person said this picture is decoration only. */
  readonly markedDecorative: boolean;
}): AltState {
  if (input.alt.trim() !== '') return 'described';
  if (input.isLink) return 'link_needs_words';
  return input.markedDecorative ? 'decorative' : 'owed';
}
