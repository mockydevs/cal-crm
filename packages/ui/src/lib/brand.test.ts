import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyBrand,
  brandColors,
  contrastRatio,
  DEFAULT_ACCENT,
  luminance,
  MIN_CONTRAST,
  mix,
} from './brand';

const GROUND = '#F8F9FA';
const hexColor = fc
  .integer({ min: 0, max: 0xffffff })
  .map((value) => `#${value.toString(16).padStart(6, '0')}`);

describe('contrastRatio', () => {
  it('spans 1 to 21', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#0F7A68', '#0F7A68')).toBe(1);
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(hexColor, hexColor, (first, second) => {
        expect(contrastRatio(first, second)).toBeCloseTo(contrastRatio(second, first), 10);
      }),
    );
  });

  it('refuses anything but #RRGGBB', () => {
    expect(() => luminance('#FFF')).toThrow(TypeError);
    expect(() => luminance('teal')).toThrow('Not a #RRGGBB color: teal');
  });
});

describe('mix', () => {
  it('returns the ends at 0 and 1', () => {
    expect(mix('#0F7A68', '#FFFFFF', 0)).toBe('#0F7A68');
    expect(mix('#0F7A68', '#FFFFFF', 1)).toBe('#FFFFFF');
  });
});

describe('brandColors', () => {
  it('keeps the default accent as it is', () => {
    const colors = brandColors(DEFAULT_ACCENT);
    expect(colors).toMatchObject({
      accent: '#155EEF',
      accentInk: '#FFFFFF',
      accentText: '#155EEF',
      adjusted: false,
    });
  });

  it('keeps the text on the accent readable, whatever the color', () => {
    fc.assert(
      fc.property(hexColor, (accent) => {
        const colors = brandColors(accent);
        expect(contrastRatio(colors.accentInk, colors.accent)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }),
    );
  });

  it('keeps accent-colored links readable on the page background', () => {
    fc.assert(
      fc.property(hexColor, (accent) => {
        expect(contrastRatio(brandColors(accent).accentText, GROUND)).toBeGreaterThanOrEqual(
          MIN_CONTRAST,
        );
      }),
    );
  });

  it('never makes the hover state less readable than the accent', () => {
    fc.assert(
      fc.property(hexColor, (accent) => {
        const colors = brandColors(accent);
        expect(contrastRatio(colors.accentInk, colors.accentHover)).toBeGreaterThanOrEqual(
          contrastRatio(colors.accentInk, colors.accent),
        );
      }),
    );
  });

  it('says when it had to change a color', () => {
    const light = brandColors('#FFE066');
    expect(light.accentInk).toBe('#101828');
    expect(light.accent).toBe('#FFE066');
    expect(light.adjusted).toBe(true);
    expect(light.accentText).not.toBe('#FFE066');

    const midGray = brandColors('#777777');
    expect(midGray.accent).not.toBe('#777777');
    expect(midGray.accentInk).toBe('#FFFFFF');
    expect(midGray.adjusted).toBe(true);
  });

  it('returns upper-case #RRGGBB values', () => {
    fc.assert(
      fc.property(hexColor, (accent) => {
        const colors = brandColors(accent);
        const tokens = [
          colors.accent,
          colors.accentInk,
          colors.accentHover,
          colors.accentSubtle,
          colors.accentText,
        ];
        for (const value of tokens) {
          expect(value).toMatch(/^#[0-9A-F]{6}$/);
        }
      }),
    );
  });

  it('matches the defaults in globals.css, so the first paint is already right', () => {
    // Prettier writes hex colors in lower case; CSS doesn't mind either way.
    const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
    const colors = brandColors(DEFAULT_ACCENT);
    const declared = (token: string, value: string): string =>
      `--${token}: ${value.toLowerCase()};`;
    expect(css).toContain(declared('accent', colors.accent));
    expect(css).toContain(declared('accent-ink', colors.accentInk));
    expect(css).toContain(declared('accent-hover', colors.accentHover));
    expect(css).toContain(declared('accent-subtle', colors.accentSubtle));
    expect(css).toContain(declared('accent-text', colors.accentText));
  });
});

describe('the default theme in globals.css', () => {
  const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
  /** A meaning's color: its own value, or the palette value it points at. */
  const token = (name: string): string => {
    const declared = new RegExp(
      `\\s--${name}: (#[0-9a-f]{6}|var\\(--(palette-[a-z0-9-]+)\\));`,
    ).exec(css);
    if (declared?.[1] === undefined) throw new Error(`globals.css has no --${name}`);
    return declared[2] === undefined ? declared[1] : token(declared[2]);
  };

  // Every text color with every fill it is put on, hover fills included (column is the
  // hover fill of rows and quiet buttons, accent-subtle the highlighted option's).
  const onFills = (texts: readonly string[], fills: readonly string[]): [string, string][] =>
    texts.flatMap((text) => fills.map((fill): [string, string] => [text, fill]));
  const pairs = [
    ...onFills(
      ['ink', 'body', 'muted', 'accent-text', 'danger'],
      ['ground', 'surface', 'panel', 'column', 'accent-subtle'],
    ),
    // Muted text is too faint for the well (4.28): only ink and body go on it.
    ...onFills(['ink', 'body'], ['well']),
    ...onFills(['accent-ink'], ['accent', 'accent-hover']),
    ...onFills(['sidebar-ink'], ['sidebar', 'sidebar-active']),
    ...onFills(['attention-ink'], ['attention']),
    ...onFills(['neutral-pill-ink'], ['neutral-pill']),
    ...onFills(['assistant-pill-ink', 'ink'], ['assistant-pill']),
    ...onFills(['success'], ['success-subtle', 'surface']),
    ...onFills(['ink'], ['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']),
  ];

  it.each(pairs)('keeps %s readable on %s', (text, fill) => {
    expect(contrastRatio(token(text), token(fill))).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("uses the colors brandColors() derives the accent's readable variants from", () => {
    expect(token('ground').toUpperCase()).toBe(GROUND);
    expect(brandColors('#FFE066').accentInk).toBe(token('ink').toUpperCase());
  });
});

describe('applyBrand', () => {
  it('sets every accent token on the element', () => {
    const set = new Map<string, string>();
    applyBrand(
      { style: { setProperty: (name, value) => set.set(name, value) } },
      brandColors('#2C5BE0'),
    );
    expect([...set.keys()]).toEqual([
      '--accent',
      '--accent-ink',
      '--accent-hover',
      '--accent-subtle',
      '--accent-text',
    ]);
    expect(set.get('--accent')).toBe('#2C5BE0');
  });
});
