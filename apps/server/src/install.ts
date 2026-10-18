// The migrate container's command: node dist/install.js (see install-cli.ts).
import { install } from './install-cli.js';

process.exitCode = await install(process.env, process);
