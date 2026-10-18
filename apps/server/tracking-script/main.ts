// The bundle's entry: tools/build.ts makes external-tracking.bundle.js from this file. The tag
// that loaded it is the one running now: document.currentScript, read before anything else.
import { startTracking } from './tracker.js';

const script = document.currentScript;
startTracking(document, window, script instanceof HTMLScriptElement ? script : null);
