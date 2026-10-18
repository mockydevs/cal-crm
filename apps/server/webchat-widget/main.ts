// The bundle's entry: tools/build.ts makes widget.bundle.js from this file. It only finds the
// script tag it is running from and hands over to entry.ts, which is what tests import.
import { install } from './entry.js';

// Set while a classic script runs, async ones included; null in a module or a callback.
install(window, document.currentScript);
