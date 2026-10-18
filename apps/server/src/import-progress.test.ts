import { expect, it } from 'vitest';

import { logImportProgress } from './import-progress.js';

const importId = '01890a5d-ac96-774b-bcce-b302099a8057';
const businessId = '01890a5d-ac96-774b-bcce-b302099a8058';

it('logs each batch and the end of an import, with ids and counts and nothing else', () => {
  const lines: { fields: object; message: string }[] = [];
  const log = logImportProgress({
    info: (fields, message) => {
      lines.push({ fields, message });
    },
  });

  log({ importId, businessId, event: 'batch', status: 'running', processed: 100, found: 250 });
  log({
    importId,
    businessId,
    event: 'ended',
    status: 'failed',
    processed: 100,
    found: 250,
    errorCode: 'file_missing',
  });

  expect(lines).toEqual([
    {
      message: 'import batch applied',
      fields: {
        source: 'imports',
        importId,
        businessId,
        event: 'batch',
        status: 'running',
        processed: 100,
        found: 250,
      },
    },
    {
      message: 'import ended',
      fields: {
        source: 'imports',
        importId,
        businessId,
        event: 'ended',
        status: 'failed',
        processed: 100,
        found: 250,
        errorCode: 'file_missing',
      },
    },
  ]);
});
