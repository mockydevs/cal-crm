// The booking page's look, from a calendar's Widget appearance. GoHighLevel has two widget
// styles, and its help article ("Configuring Calendar Widget Style (Classic & Neo)",
// help.gohighlevel.com, article 155000003552) says colours, backgrounds and button text are
// the Neo widget's alone: Classic is its standard look. So only Neo turns the two colours
// into the design tokens (packages/ui/src/styles/globals.css) of the widget and nothing
// outside it, each moved only as far as readable text needs: 4.5:1, WCAG 2.2 AA for normal
// text, for every word on the background and on the primary colour.
//
// The tokens are set as CSS custom properties through the element's style object (React
// calls style.setProperty for them), which a Content Security Policy's style-src does not
// govern: no style attribute or style element is written into the page.
import type { PublicCalendarAppearance } from '@repo/contracts';
import { contrastRatio, mix, MIN_CONTRAST } from '@repo/ui/lib/brand';

const WHITE = '#FFFFFF';
const BLACK = '#000000';
/** The default theme's text colour, tried before black. */
const INK = '#101828';
/** The page's ground, which a see-through background colour shows over. */
const GROUND = '#F8F9FA';
/** The default theme's error colour, moved like the rest when the background needs it. */
const DANGER = '#B42318';

/** A #rrggbb or #rrggbbaa colour as the opaque #RRGGBB it shows as over `under`. */
export function flatten(color: string, under: string): string {
  const alpha = color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1;
  return mix(under, color.slice(0, 7), alpha);
}

/** The text colour for words on `fill`: the theme's ink or white, or black where neither reads. */
export function inkOn(fill: string): string {
  const onWhite = contrastRatio(WHITE, fill);
  const onInk = contrastRatio(INK, fill);
  if (Math.max(onWhite, onInk) >= MIN_CONTRAST) return onWhite >= onInk ? WHITE : INK;
  // Black or white always reaches at least 4.58:1, whatever the fill.
  return contrastRatio(BLACK, fill) >= onWhite ? BLACK : WHITE;
}

/** `color` as words on `ground`: itself when it reads, else moved toward the ground's ink. */
export function readableOn(color: string, ground: string): string {
  const ink = inkOn(ground);
  let result = color;
  for (let step = 1; contrastRatio(result, ground) < MIN_CONTRAST; step += 1)
    result = mix(color, ink, Math.min(1, step / 20));
  return result;
}

/** The tokens a Neo widget sets on itself, by their custom property names. */
export type BookingTheme = Readonly<Record<`--${string}`, string>>;

/** The widget's tokens from its two colours. */
export function bookingTheme(primaryColor: string, backgroundColor: string): BookingTheme {
  const ground = flatten(backgroundColor, GROUND);
  const ink = inkOn(ground);
  const accent = flatten(primaryColor, ground);
  const accentInk = inkOn(accent);
  return {
    '--surface': ground,
    '--ink': ink,
    '--body': readableOn(mix(ink, ground, 0.25), ground),
    '--muted': readableOn(mix(ink, ground, 0.4), ground),
    '--line': mix(ink, ground, 0.82),
    '--control-line': mix(ink, ground, 0.7),
    '--column': mix(ink, ground, 0.94),
    '--danger': readableOn(DANGER, ground),
    '--accent': accent,
    '--accent-ink': accentInk,
    // Away from its words, so a hovered button only gets more readable.
    '--accent-hover': mix(accent, accentInk === WHITE ? BLACK : WHITE, 0.2),
    '--accent-subtle': mix(accent, ground, 0.88),
    '--accent-text': readableOn(accent, ground),
  };
}

export interface BookingLook {
  /** The widget's tokens; none for Classic, which keeps the page's own. */
  readonly theme: BookingTheme | undefined;
  /** Light words on a dark background: the browser's own controls (a date picker) follow. */
  readonly scheme: 'light' | 'dark';
  /** The booking button's words; none for the page's own. */
  readonly buttonText: string | undefined;
}

/** What the page draws: the theme only for Neo, the button's own words only for Neo too. */
export function bookingLook(appearance: PublicCalendarAppearance): BookingLook {
  if (appearance.style === 'classic')
    return { theme: undefined, scheme: 'light', buttonText: undefined };
  const theme = bookingTheme(appearance.primaryColor, appearance.backgroundColor);
  const words = appearance.buttonText.trim();
  return {
    theme,
    scheme: theme['--ink'] === WHITE ? 'dark' : 'light',
    buttonText: words === '' ? undefined : words,
  };
}
