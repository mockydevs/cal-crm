import { createFileRoute } from '@tanstack/react-router';
import { EmailPage } from '../email';

export const Route = createFileRoute('/_app/b/$slug/settings/email')({ component: EmailPage });
