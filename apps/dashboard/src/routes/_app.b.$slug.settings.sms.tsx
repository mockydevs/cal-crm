import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { loadPhoneWords } from '../phone-words';

export const Route = createFileRoute('/_app/b/$slug/settings/sms')({ component: PhoneRoute });
const PhoneSystemPage = lazy(async () => {
  const [phone] = await Promise.all([import('../phone-system'), loadPhoneWords()]);
  return { default: phone.PhoneSystemPage };
});
function PhoneRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <PhoneSystemPage />
    </Suspense>
  );
}
