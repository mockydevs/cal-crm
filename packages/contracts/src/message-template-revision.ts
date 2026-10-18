import * as z from 'zod';

/** The canonical content digest shared by library edits and workflow provenance. */
export const messageTemplateRevision = z.string().regex(/^[0-9a-f]{64}$/);
