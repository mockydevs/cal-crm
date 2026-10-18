# packages/ui

The design system: tokens, the white-label accent, and the base components, all in
`src/styles/globals.css`. The dashboard compiles
this package's source directly; it has no build step.

```ts
import '@repo/ui/globals.css';
import { Button } from '@repo/ui/components/button';
import { applyBrand, brandColors } from '@repo/ui/lib/brand';
```

## Tokens

[src/styles/globals.css](src/styles/globals.css) has three layers:

1. **The palette:** raw colors, used only by the next layer.
2. **Meanings,** named for what they mean (`--ground`, `--surface`, `--ink`, `--muted`,
   `--accent` and so on). Branding changes only these.
3. **The Tailwind theme:** the class names components use. It follows shadcn/ui's
   vocabulary, so components added with the shadcn CLI pick up our tokens as they are.

These names differ between a meaning and its class name:

| Meaning | CSS variable | Tailwind class |
|---|---|---|
| accent (the agency's color) | `--accent` | `bg-primary`, `text-primary-foreground` |
| muted (secondary text) | `--muted` | `text-muted-foreground` |
| column (subtle background) | `--column` | `bg-muted` |

Tailwind's own colors are switched off, so a hard-coded color like `bg-red-500` doesn't
exist; every color comes from a token.

## The agency's accent

`brandColors(accent)` in [src/lib/brand.ts](src/lib/brand.ts) turns one color into the
accent tokens:
- the text on it (white or ink, whichever is readable);
- a hover shade and a subtle tint;
- a version for links;
- an `adjusted` flag for when a color had to change.

Property tests check that every result meets WCAG AA contrast, for any color.
`applyBrand(document.documentElement, colors)` puts them on the page.

## Adding a shadcn/ui component

```bash
cd packages/ui
pnpm dlx shadcn@4.21.3 add tooltip
```

Then:
- change its `import { cn } from "cn"` to `import { cn } from '../lib/utils'` (lint insists);
- remove `cn` from package.json if the CLI added it;
- theme it with the tokens above, and add a test;
- keep only the parts something uses, so nothing goes untested.

The CLI also adds `cn` to pnpm-workspace.yaml's catalog; take that out too.

## Tests

Most tests render a component to markup (`components.test.tsx`). Components that open a
popup, such as the dropdown menu, render it only in a browser, so their tests start with
`// @vitest-environment jsdom` and use Testing Library (`dropdown-menu.test.tsx`).
