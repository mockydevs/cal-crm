import { createFileRoute } from '@tanstack/react-router';
import { WebchatSettingsPage } from '../webchat-settings';

export const Route = createFileRoute('/_app/b/$slug/settings/webchat')({
  component: WebchatSettingsPage,
});
