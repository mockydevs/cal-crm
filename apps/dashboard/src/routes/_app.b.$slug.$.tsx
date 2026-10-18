import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../shell/not-found';

// An address in a business that no page has, shown with the business's own menu.
export const Route = createFileRoute('/_app/b/$slug/$')({ component: NotFound });
