// The bundle's entry: tools/build.ts makes arrival.js from this file. Deferred, so the page
// is parsed by the time it runs; and a classic script, so the tag it was loaded by is known
// while it runs (document.currentScript), which is where the site's key is written.
import { startArrival } from './arrival.js';

startArrival(document, window, document.currentScript);
