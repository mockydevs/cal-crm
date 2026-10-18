// What Puck gets in place of `@radix-ui/react-popover` when the dashboard is built
// (vite.config.ts, puckWithoutPopover). In @puckeditor/core 0.23.0 that package is imported
// in one place: components/Select, the drop-down of the rich text menu (heading, alignment
// and list selects), which is drawn only while a `richtext` field is edited. The page
// editor has no such field: text is edited as runs, never as HTML. So the popover, and the
// positioning library it brings, are left out of what the editor downloads. Each stand-in
// refuses to be drawn, so a release of Puck that starts using the popover somewhere else
// fails where it is seen, not silently.
const refuse = (): never => {
  throw new Error(
    'The canvas library asked for its popover, which this build leaves out: it belongs to rich text, which the page editor does not use (src/site-editor/puck-popover-off.ts).',
  );
};

export const Popover = refuse;
export const PopoverContent = refuse;
export const PopoverPortal = refuse;
export const PopoverTrigger = refuse;
