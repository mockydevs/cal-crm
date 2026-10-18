import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { showsInline } from './types.js';

/** Only a live raster image belonging to this business may become its logo. */
export async function checkBusinessLogo(
  trx: DatabaseTransaction,
  businessId: string,
  fileId: string,
): Promise<void> {
  const file = await trx
    .selectFrom('files.files')
    .select('content_type')
    .where('id', '=', parsePublicId('file', fileId) ?? '')
    .where('business_id', '=', businessId)
    .where('deleted_at', 'is', null)
    // A file kept for one purpose, such as a record's document, is no picture to show.
    .where('purpose', 'is', null)
    .executeTakeFirst();
  if (file === undefined) throw new NotFoundError('File', fileId);
  if (!showsInline(file.content_type))
    throw new ValidationError([
      {
        path: '/logoFileId',
        code: 'image_required',
        message: 'Choose a PNG, JPEG, GIF or WebP image for the logo.',
      },
    ]);
}
