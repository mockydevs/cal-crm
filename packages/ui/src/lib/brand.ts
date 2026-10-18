// An agency's accent color, turned into the color tokens the app uses. Every token stays
// readable whatever color the agency picks.

/** WCAG 2.2 AA for normal text. */
export const MIN_CONTRAST = 4.5;

export const DEFAULT_ACCENT = '#155EEF';

const WHITE = '#FFFFFF';
const BLACK = '#000000';
/** The default theme's text color, tried before white for light accents. */
const INK = '#101828';
/** The page background, which accent-colored links sit on. */
const GROUND = '#F8F9FA';

const HEX = /^#[0-9a-f]{6}$/i;

export interface BrandColors {
  /** Fill for primary buttons and the active navigation item. */
  readonly accent: string;
  /** Text and icons on the accent fill. */
  readonly accentInk: string;
  /** The fill on hover: moves away from the ink, so it only gets more readable. */
  readonly accentHover: string;
  /** A light tint for subtle backgrounds. */
  readonly accentSubtle: string;
  /** The accent as text (links) on the page background. */
  readonly accentText: string;
  /** True when a color had to change to stay readable, so branding settings can say so. */
  readonly adjusted: boolean;
}

function channels(hex: string): [number, number, number] {
  if (!HEX.test(hex)) {
    throw new TypeError(`Not a #RRGGBB color: ${hex}`);
  }
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex([red, green, blue]: [number, number, number]): string {
  const value = (red << 16) | (green << 8) | blue;
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

function linear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, from 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [red, green, blue] = channels(hex);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** WCAG contrast ratio between two colors, from 1 to 21. */
export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Moves `from` toward `to` by `amount` (0 to 1). */
export function mix(from: string, to: string, amount: number): string {
  const [fromRed, fromGreen, fromBlue] = channels(from);
  const [toRed, toGreen, toBlue] = channels(to);
  const step = (start: number, end: number): number => Math.round(start + (end - start) * amount);
  return toHex([step(fromRed, toRed), step(fromGreen, toGreen), step(fromBlue, toBlue)]);
}

/** Darkens `color` in 5% steps until `against` reaches the minimum contrast with it. */
function darkenUntilReadable(color: string, against: string): string {
  let result = color;
  for (let step = 1; contrastRatio(result, against) < MIN_CONTRAST; step += 1) {
    result = mix(color, BLACK, step / 20);
  }
  return result;
}

export function brandColors(accent: string): BrandColors {
  const requested = toHex(channels(accent));
  const onWhite = contrastRatio(WHITE, requested);
  const onInk = contrastRatio(INK, requested);

  let fill = requested;
  let accentInk = onWhite >= onInk ? WHITE : INK;
  if (Math.max(onWhite, onInk) < MIN_CONTRAST) {
    fill = darkenUntilReadable(requested, WHITE);
    accentInk = WHITE;
  }

  const accentText = darkenUntilReadable(fill, GROUND);
  const accentHover = mix(fill, accentInk === WHITE ? BLACK : WHITE, 0.2);

  return {
    accent: fill,
    accentInk,
    accentHover,
    accentSubtle: mix(fill, WHITE, 0.93),
    accentText,
    adjusted: fill !== requested || accentText !== fill,
  };
}

/** Anything with an inline style, such as `document.documentElement`. */
export interface StyleTarget {
  readonly style: { setProperty(name: string, value: string): void };
}

/** Sets the accent tokens on an element; everything below it restyles. */
export function applyBrand(target: StyleTarget, colors: BrandColors): void {
  target.style.setProperty('--accent', colors.accent);
  target.style.setProperty('--accent-ink', colors.accentInk);
  target.style.setProperty('--accent-hover', colors.accentHover);
  target.style.setProperty('--accent-subtle', colors.accentSubtle);
  target.style.setProperty('--accent-text', colors.accentText);
}
