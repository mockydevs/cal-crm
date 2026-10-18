// The bundle's entry: tools/build.ts makes countdown.js from this file. Deferred, so the
// page is parsed by the time it runs.
import { startCountdowns } from './countdown.js';

startCountdowns(document, window);
