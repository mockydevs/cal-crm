import { createFileRoute } from '@tanstack/react-router';
import { TrashPage } from '../trash';

export const Route = createFileRoute('/_app/b/$slug/trash')({ component: TrashPage });
