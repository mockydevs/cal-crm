import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { savePipelinesInput } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { stageColorChoices, stageColorOf } from './pipeline-stage-colors';

const css = readFileSync(
  fileURLToPath(new URL('../../../packages/ui/src/styles/globals.css', import.meta.url)),
  'utf8',
);

/** What globals.css gives a custom property, following one token to the next. */
function declared(token: string): string {
  const value = new RegExp(`^\\s*${token}:\\s*([^;]+);`, 'm').exec(css)?.[1]?.trim();
  if (value === undefined) throw new Error(`No ${token} in globals.css`);
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
  return reference === undefined ? value : declared(reference);
}
const styles = (values: Record<string, string>) => ({
  getPropertyValue: (name: string) => values[name] ?? '',
});

describe('the colours a stage can be given', () => {
  it('are tokens of the design system, each a different colour the server takes', () => {
    const colors = stageColorChoices.map((choice) =>
      stageColorOf(choice, styles({ [choice.token]: declared(choice.token) })),
    );
    expect(new Set(colors).size).toBe(stageColorChoices.length);
    for (const color of colors) {
      const stage = { name: 'New lead', description: '', archived: false, color };
      const pipeline = { name: 'Weddings', description: '', archived: false, stages: [stage] };
      expect(
        savePipelinesInput.safeParse({ revision: 'a'.repeat(64), items: [pipeline] }).success,
      ).toBe(true);
    }
  });

  it('fill their swatch with a class the theme has for the same token', () => {
    for (const { token, className } of stageColorChoices) {
      const themed = new RegExp(`--color-${className.slice(3)}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(
        css,
      )?.[1];
      expect(themed).toBe(token);
    }
  });

  it('send lower-case #rrggbb, and nothing for a value that is not a plain hex colour', () => {
    const choice = { token: '--success' };
    expect(stageColorOf(choice, styles({ '--success': ' #027A48 ' }))).toBe('#027a48');
    expect(stageColorOf(choice, styles({ '--success': '#0A8' }))).toBe('#00aa88');
    expect(stageColorOf(choice, styles({ '--success': 'oklch(0.5 0.1 150)' }))).toBeUndefined();
    expect(stageColorOf(choice, styles({}))).toBeUndefined();
  });
});
