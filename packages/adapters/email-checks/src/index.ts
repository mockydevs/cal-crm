export { verifyEmail } from './verify.js';
export type { EmailVerification, VerifyEmailOptions } from './verify.js';
export type {
  AccountOutcome,
  MailboxOutcome,
  MailboxProvider,
  MailboxResult,
  ProviderCallOptions,
  ProviderFailure,
  ProviderProblem,
  VerificationReason,
  VerificationStatus,
} from './provider.js';
export { emailableProvider } from './emailable.js';
export type { EmailableOptions } from './emailable.js';
export { checkSyntax } from './syntax.js';
export type { SyntaxCheck, SyntaxProblem, UnsupportedSyntax } from './syntax.js';
export { checkDomain, DEFAULT_DNS_BUDGET } from './domain.js';
export type { DomainCheck, DomainCheckOptions } from './domain.js';
export { isDisposableDomain, isRoleAddress } from './lists.js';
