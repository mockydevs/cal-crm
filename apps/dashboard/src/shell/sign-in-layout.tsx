import type { ReactElement, ReactNode } from 'react';
import { signInAgency } from '../session';
import { BrandMark } from './brand-mark';
import { NamedPage } from './page';

export interface SignInLayoutProps {
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * The pages for people not signed in: one card on the page, under the agency's mark. The
 * agency sets its own sign-in page later (FRONTEND.md section 6).
 */
export function SignInLayout({ title, children }: SignInLayoutProps): ReactElement {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:items-center">
      <div className="flex w-full max-w-[440px] flex-col gap-6">
        <div className="flex items-center gap-2.5 self-center">
          <BrandMark />
          <span className="text-md leading-[normal] font-semibold">{signInAgency.name}</span>
        </div>
        <div className="flex flex-col gap-5 rounded-card border bg-card p-6 sm:p-8">
          <NamedPage title={title} place={signInAgency.name}>
            {children}
          </NamedPage>
        </div>
      </div>
    </main>
  );
}

/** Where to go after signing in: only a page on this site, never another one. */
export function safeNext(next: string | undefined): string {
  return next !== undefined && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
