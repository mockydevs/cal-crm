// The bundle's entry: tools/build.ts makes booking-embed.bundle.js from this file. It may run
// before or after the frames it sizes are on the page: a frame added later says `ready`
// and is greeted then.
import { startBookingFrames } from './sizer.js';

startBookingFrames(document, window);
