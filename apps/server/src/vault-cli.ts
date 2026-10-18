// The vault's command. new-key makes a key and its public key, for a new install or a
// rotation. rotate, run in the worker's container, re-seals every secret under the current
// key, so the older ones can be removed.
import { createVault, newSecretsKey } from '@repo/module-vault';

import { connectForCommand, messageOf, type Output } from './cli.js';
import { ConfigError, loadConfig, type Config } from './config.js';

const USAGE = `Usage:
  node dist/vault.js new-key <version>          a new key: SECRETS_KEYS for the worker, SECRETS_PUBLIC_KEY for the app
  node dist/vault.js rotate [--batch-size <n>]  in the worker: re-seal every secret under the current key
`;

/** A whole number from min to max, or undefined. */
function wholeNumber(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

async function newKey(args: readonly string[], stdout: Output): Promise<number | undefined> {
  const version = args.length === 1 ? wholeNumber(args[0], 1, 32_767) : undefined;
  if (version === undefined) return undefined;
  const made = await newSecretsKey(version);
  stdout.write(
    [
      `Key version ${String(version)}. Keep SECRETS_KEYS secret, and back it up apart from the database's backups:`,
      'without it, no stored secret can be opened.',
      '',
      `SECRETS_KEYS=${made.secretsKey}`,
      `SECRETS_PUBLIC_KEY=${made.publicKey}`,
      '',
      'A new install: give SECRETS_KEYS to the worker, and SECRETS_PUBLIC_KEY to the app.',
      'A rotation, in two deploys, so the worker can always open what the app seals:',
      "  1. Add the new key to the worker's SECRETS_KEYS after the current one, and deploy.",
      '  2. Move it first, give the app the new SECRETS_PUBLIC_KEY, and deploy.',
      "  3. Run node dist/vault.js rotate in the worker's container.",
      '',
    ].join('\n'),
  );
  return 0;
}

/** The worker's settings, checked as the worker checks them at start. */
function workerSettings(
  env: Readonly<Record<string, string | undefined>>,
  stderr: Output,
): Config | undefined {
  try {
    return loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(
      `${error.message}\nRun rotate in the worker's container, which has its settings.\n`,
    );
    return undefined;
  }
}

async function rotate(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: { stdout: Output; stderr: Output },
): Promise<number | undefined> {
  let batchSize: number | undefined;
  if (args.length === 2 && args[0] === '--batch-size') {
    batchSize = wholeNumber(args[1], 1, 1000);
    if (batchSize === undefined) return undefined;
  } else if (args.length > 0) {
    return undefined;
  }
  const config = workerSettings(env, output.stderr);
  if (config === undefined) return 2;
  if (config.vault?.holds !== 'private') {
    output.stderr.write(
      "Error: rotate runs in the worker's container, which holds SECRETS_KEYS; these are the app's settings.\n",
    );
    return 2;
  }

  const vault = await createVault(config.vault.keys);
  const db = connectForCommand(config.databaseAppUrl);
  try {
    const report = await vault.rotate(db, {
      ...(batchSize === undefined ? {} : { batchSize }),
      afterBatch: (progress) => {
        output.stdout.write(`Re-sealed ${String(progress.rotated)} so far.\n`);
      },
    });
    const secrets = report.rotated === 1 ? 'secret' : 'secrets';
    output.stdout.write(
      `Re-sealed ${String(report.rotated)} ${secrets} under key version ${String(report.keyVersion)}.\n`,
    );
    if (report.failed.length > 0) {
      output.stderr.write(
        `Couldn't open ${String(report.failed.length)}, which keep their older key: ${report.failed.join(', ')}. ` +
          'They were changed in the database, or sealed under a key SECRETS_KEYS no longer holds. ' +
          'Have those credentials entered again, and keep the older keys until then.\n',
      );
      return 1;
    }
    if (report.remaining > 0) {
      output.stderr.write(
        `${String(report.remaining)} still under an older key: an app on the old SECRETS_PUBLIC_KEY sealed them meanwhile. ` +
          `Give every app key version ${String(report.keyVersion)}'s public key, run rotate again, and keep the older keys until then.\n`,
      );
      return 1;
    }
    output.stdout.write(
      `Every secret is under key version ${String(report.keyVersion)}: you can remove the older keys from SECRETS_KEYS.\n`,
    );
    return 0;
  } catch (error) {
    output.stderr.write(`Rotation failed: ${messageOf(error)}\n`);
    return 1;
  } finally {
    await db.destroy();
  }
}

/** Returns the exit code: 0 when done, 1 when it failed, 2 for a wrong command or setting. */
export async function vault(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: { stdout: Output; stderr: Output },
): Promise<number> {
  const [command, ...rest] = args;
  const code =
    command === 'new-key'
      ? await newKey(rest, output.stdout)
      : command === 'rotate'
        ? await rotate(rest, env, output)
        : undefined;
  if (code === undefined) {
    output.stderr.write(USAGE);
    return 2;
  }
  return code;
}
