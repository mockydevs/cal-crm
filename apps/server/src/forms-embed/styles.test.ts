import { expect, it } from 'vitest';

import { strings } from './strings.js';
import { css, tokens } from './styles.js';

// WCAG 2.2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

it('measures contrast as WCAG does', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
});

it.each([
  ['questions and answers', tokens.ink, tokens.surface],
  ['hints and the description', tokens.muted, tokens.surface],
  ['the button', tokens.accentInk, tokens.accent],
  ['a hovered button', tokens.accentInk, tokens.accentHover],
  ['a problem', tokens.danger, tokens.surface],
])('gives %s a contrast of at least 4.5 to 1', (_what, foreground, background) => {
  expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
});

it.each([
  ['a field border', tokens.muted, tokens.surface],
  ['the focus ring', tokens.accent, tokens.surface],
  ['the border of a refused answer', tokens.danger, tokens.surface],
])('gives %s a contrast of at least 3 to 1', (_what, foreground, background) => {
  expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3);
});

it('uses only its own colours, and fetches nothing', () => {
  const used = new Set(css.match(/#[0-9a-f]{3,8}\b/gi) ?? []);
  expect(used.size).toBeGreaterThan(4);
  for (const colour of used) expect(Object.values(tokens)).toContain(colour);
  expect(css).not.toMatch(/url\(|@import|@font-face|expression\(/i);
});

it('fits a narrow screen, honours reduced motion, and never hides what has focus', () => {
  // As wide as the place it is put in, and no wider than a form reads well.
  expect(css).toMatch(/section\{[^}]*width:100%;max-width:560px/);
  expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  expect(css).toContain(':focus-visible{outline:2px solid');
  expect(css).not.toMatch(/outline:\s*(none|0)\b/);
  // Fields are 16px, so phones do not zoom the page when one is focused, and 44px tall.
  expect(css).toMatch(/textarea\{[^}]*min-height:44px;[^}]*font-size:16px/);
  expect(css).toMatch(/\.primary\{[^}]*min-height:44px/);
  // Long words in a label or a message wrap instead of widening the page.
  expect(css).toContain('overflow-wrap:anywhere');
});

it("puts nothing on the host element, which the website's own rules can reach", () => {
  // The host only resets itself. Everything the form's text inherits is on the frame
  // inside the shadow root, out of reach of the page.
  expect(css).toContain(':host{all:initial}');
  const frame = /\nsection\{([^}]*)\}/.exec(css)?.[1] ?? '';
  for (const declared of [
    'all:initial',
    'font-family:system-ui',
    'font-size:16px',
    'line-height:1.45',
    `color:${tokens.ink}`,
    `background:${tokens.surface}`,
    'direction:ltr',
    'text-align:left',
  ])
    expect(frame, declared).toContain(declared);
  // No other rule speaks of the host.
  expect(css.match(/:host/g)).toHaveLength(1);
});

it('keeps the field people are not meant to fill out of sight without removing it', () => {
  const trap = /\.trap\{([^}]*)\}/.exec(css)?.[1] ?? '';
  // Not display:none: a program that skips hidden fields would skip it too.
  expect(trap).toContain('position:absolute');
  expect(trap).toContain('clip-path:inset(50%)');
  expect(trap).not.toMatch(/display:\s*none|visibility:\s*hidden/);
});

it('keeps every word short and plain', () => {
  for (const [key, text] of Object.entries(strings)) {
    expect(text.trim(), key).toBe(text);
    expect(text.length, key).toBeLessThanOrEqual(110);
    expect(text, key).not.toMatch(/[<>{}]|\$\{/);
  }
});
