import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../shell/not-found';

// Any address no page has, for someone signed in; anyone else is asked to sign in first.
export const Route = createFileRoute('/_app/$')({ component: NotFound });
