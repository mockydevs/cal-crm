// Verified against mailauth 7.1.1 lib/spf/syntax.js; its public evaluator uses this parser.
declare module 'mailauth/lib/spf/syntax.js' {
  export function validateTerms(terms: string[]): string | false;
}
