// Where the browser tests' copy of the build is kept (see serve-build.ts).
import { fileURLToPath } from 'node:url';

/** The build as `vite build` leaves it, which any later build empties and writes again. */
export const builtDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
/** The copy the tests are served from, and read the build's manifest from. */
export const servedDirectory = fileURLToPath(
  new URL('../node_modules/.cache/e2e-served-build/', import.meta.url),
);
