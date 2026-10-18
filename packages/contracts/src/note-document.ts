// A note's text as it is stored: bounded simple rich text. On its own so that what only
// checks a note's text (the automation catalog's Create note step) does not load the note
// endpoints with it.
import * as z from 'zod';

const mark = z.strictObject({ type: z.enum(['bold', 'italic', 'code']) });
const text = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1).max(100000),
  marks: z
    .array(mark)
    .max(3)
    .refine(
      (marks) =>
        new Set(marks.map((mark) => mark.type)).size === marks.length &&
        (marks.length <= 1 || !marks.some((mark) => mark.type === 'code')),
      { error: 'Use each formatting mark once, and code without other formatting.' },
    )
    .optional(),
});
const inline = z.union([text, z.strictObject({ type: z.literal('hardBreak') })]);
const paragraph = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(inline).max(2000).optional(),
});
/** Bounded simple rich text; HTML, links, embeds and arbitrary attributes are refused. */
export const noteDocument = z
  .strictObject({ type: z.literal('doc'), content: z.array(paragraph).min(1).max(2000) })
  .superRefine((document, context) => {
    let length = document.content.length - 1;
    let nodes = document.content.length;
    let hasText = false;
    for (const paragraph of document.content) {
      for (const node of paragraph.content ?? []) {
        nodes++;
        length += node.type === 'text' ? node.text.length : 1;
        if (node.type === 'text' && node.text.trim() !== '') hasText = true;
      }
    }
    if (!hasText) context.addIssue({ code: 'custom', message: 'Write something in the note.' });
    if (length > 100000 || nodes > 2000)
      context.addIssue({
        code: 'custom',
        message: 'Keep notes within 100,000 characters and 2,000 nodes.',
      });
  })
  .meta({ id: 'NoteDocument' });
export type NoteDocument = z.output<typeof noteDocument>;
