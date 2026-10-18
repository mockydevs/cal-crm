// The vault's command: node dist/vault.js (see vault-cli.ts).
import { vault } from './vault-cli.js';

process.exitCode = await vault(process.argv.slice(2), process.env, process);
