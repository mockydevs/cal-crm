// The bundle's entry: tools/build.ts makes popup.js from this file. Deferred, so the page
// is parsed by the time it runs.
import { startPopups } from './popup.js';

startPopups(document, window);
