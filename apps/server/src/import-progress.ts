// What an import's job writes to the log: which import, in which business, and how many
// rows it has dealt with. Ids and counts only, never a word of a row.
import type { ImportProgress } from '@repo/module-crm';

export const logImportProgress =
  (logger: { info(fields: object, message: string): void }) =>
  (progress: ImportProgress): void => {
    logger.info(
      { source: 'imports', ...progress },
      progress.event === 'ended' ? 'import ended' : 'import batch applied',
    );
  };
