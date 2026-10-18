// import-in-the-middle 3.5 publishes these types as register-hooks.d.ts, which TypeScript
// doesn't pair with register-hooks.mjs under nodenext resolution (it looks for .d.mts).
// The signatures are copied from that file.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export interface RegisterHooksOptions {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    disableCjsSourceStripping?: boolean;
  }

  /** Registers the loader as a synchronous, in-thread hook (module.registerHooks()). */
  export function register(options?: RegisterHooksOptions): void;

  /** Whether this Node.js can run the synchronous loader. */
  export function supportsSyncHooks(): boolean;
}
