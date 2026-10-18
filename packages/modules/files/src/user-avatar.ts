import { USER_LIMITS } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, ValidationError } from '@repo/kernel';
import { showsInline } from './types.js';

/**
 * Only a live raster image of this agency, of at most 2.5 MB, may become a person's
 * picture. The install's general limit on a file is larger; this one is the picture's.
 */
export async function checkUserAvatar(
  trx: DatabaseTransaction,
  agencyId: string,
  fileId: string,
): Promise<void> {
  const file = await trx
    .selectFrom('files.files')
    .select(['content_type', 'size_bytes'])
    .where('id', '=', parsePublicId('file', fileId) ?? '')
    .where('agency_id', '=', agencyId)
    .where('deleted_at', 'is', null)
    // A file kept for one purpose, such as a record's document, is no picture to show.
    .where('purpose', 'is', null)
    .executeTakeFirst();
  if (file === undefined) throw new NotFoundError('File', fileId);
  if (!showsInline(file.content_type))
    throw new ValidationError([
      {
        path: '/avatarFileId',
        code: 'image_required',
        message: 'Choose a PNG, JPEG, GIF or WebP image for the picture.',
      },
    ]);
  if (Number(file.size_bytes) > USER_LIMITS.avatarBytes)
    throw new ValidationError([
      {
        path: '/avatarFileId',
        code: 'image_too_large',
        message: 'Choose a picture of at most 2.5 MB.',
      },
    ]);
}
