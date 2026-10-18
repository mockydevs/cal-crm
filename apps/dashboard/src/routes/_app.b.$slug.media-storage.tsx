import { createFileRoute } from '@tanstack/react-router';
import { MediaStoragePage } from '../media/page';

export const Route = createFileRoute('/_app/b/$slug/media-storage')({
  component: MediaStoragePage,
});
