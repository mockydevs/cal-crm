// The evals command line, built to dist/evals/cli.js:
//
//   pnpm --filter @repo/module-ai evals -- <command>
//
//   list                    the suites, their datasets and the models Tested for each
//   run                     a suite against one real model, under a budget cap: the only
//                           command that can cost money, and it is only ever run by hand
//   replay <report>         a report's recording through the suite as it is now
//   record <report>         mark the report's model Tested, if the report shows it
//   forget                  take a model out of the Tested models, with its report
//   gate [--release]        is every Tested model still shown to pass? Free, no key
//
// A provider's key is read from the environment variable EVAL_API_KEY and from nowhere
// else. It is never an argument, never printed and never written to a report.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { parseLocalServers, type LocalServer } from '../addresses.js';
import { AI_JOBS, DEFAULT_JOB_MODELS } from '../gateway.js';
import { dollarsToMicros } from '../pricing.js';
import type { ModelPrices } from '../provider.js';
import { datasetHash, loadSuite } from './dataset.js';
import type { TestedEntry } from './entry.js';
import {
  createEvalGateway,
  EVAL_PROVIDERS,
  EvalConfigError,
  type EvalGatewayOptions,
  type EvalProvider,
} from './eval-gateway.js';
import { runGate } from './gate.js';
import { REGISTRY_PATH, REPO_ROOT } from './paths.js';
import { EvalDataError, plural } from './read.js';
import { forget, record, RecordRefused } from './record.js';
import { readRegistry } from './registry.js';
import { buildReport, readReportFile, reportPath, serializeReport } from './report.js';
import { runSuite, type CaseResult, type RunResult } from './runner.js';
import { SUITES } from './suites.js';
import type { SuiteDefinition } from './types.js';
import { replayReport } from './verify.js';

/** Where the command writes, and what a test may put in place of the repository's own. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** The repository's root. */
  readonly repoRoot?: string;
  /** The registry file `record` rewrites and `gate` reads. */
  readonly registryPath?: string;
  /** What a relative path is relative to, unless the package manager says (INIT_CWD). */
  readonly cwd?: string;
  readonly suites?: readonly SuiteDefinition[];
  readonly now?: () => Date;
  /** Trusted composition only (a test's stand-ins). No flag sets it. */
  readonly baseUrls?: EvalGatewayOptions['baseUrls'];
  readonly sleep?: EvalGatewayOptions['sleep'];
}

type Env = Readonly<Record<string, string | undefined>>;

const USAGE = `Usage: evals <command>

  list                   The suites, their datasets and the models Tested for each.
  run                    Run a suite against one model. It calls the model, so it can cost
                         money: it is never run in CI, and never without a budget.
      --job <job> --provider <anthropic|openai|openai_compatible> --model <id>
      --budget-usd <amount>         the most the run may cost, such as 0.50
      [--base-url <url>]            the model server, for openai_compatible
      [--local-server <host:port>]  allow a server on a private address or plain http
      [--price-input <usd> --price-output <usd>]   for a million tokens, when no price
      [--price-cache-read <usd>] [--price-cache-write <usd>]       is built in
      [--mask]                      mask phone numbers and email addresses before sending
      [--out <path>]                where to write the report
      [--case-timeout-ms <ms>]      the most one case may take
      The key is read from the environment variable EVAL_API_KEY, and nowhere else.
  replay <report>        Play a report's recording through the suite as it is now.
  record <report>        Mark the report's model Tested for its job, if the report shows it.
  forget --job <job> --provider <provider> --model <id>
                         Take a model out of the Tested models, and delete its kept report.
  gate [--release]       Check every Tested model against its report. No key, no network.
                         --release also asks that each suite's default model is Tested.
`;

const FLAGS = {
  list: {},
  gate: { release: { type: 'boolean' } },
  replay: {},
  record: {},
  forget: { job: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } },
  run: {
    job: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'budget-usd': { type: 'string' },
    'base-url': { type: 'string' },
    'local-server': { type: 'string', multiple: true },
    'price-input': { type: 'string' },
    'price-output': { type: 'string' },
    'price-cache-read': { type: 'string' },
    'price-cache-write': { type: 'string' },
    mask: { type: 'boolean' },
    out: { type: 'string' },
    'case-timeout-ms': { type: 'string' },
  },
} as const satisfies Record<string, ParseArgsOptionsConfig>;
type Command = keyof typeof FLAGS;
const isCommand = (value: string): value is Command => Object.hasOwn(FLAGS, value);

/** A shorter value is too likely to be part of an ordinary word to be taken out of a message. */
const MIN_KEY_LENGTH = 8;
const DEFAULT_CASE_TIMEOUT_MS = 600_000;
const MAX_CALL_TIMEOUT_MS = 300_000;

/** The arguments were not ones the command takes. The message is for the person typing. */
class UsageError extends Error {}

const amount = (flag: string, value: string): bigint => {
  try {
    return dollarsToMicros(value);
  } catch {
    throw new UsageError(`${flag} must be an amount of US dollars such as 0.50.`);
  }
};

function need(flag: string, value: string | undefined, why = ''): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is needed${why}.`);
  return value;
}

/** The flags and the other arguments of a command, or a UsageError naming the flag at fault. */
function flagsOf(
  command: Command,
  args: readonly string[],
): {
  readonly values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly positionals: readonly string[];
} {
  const options: ParseArgsOptionsConfig = FLAGS[command];
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    // Only the flag's name is repeated: what followed it might have been a key.
    const flag = /'(-{1,2}[A-Za-z][A-Za-z0-9-]*)/.exec(String(error));
    throw new UsageError(
      flag?.[1] === undefined
        ? `The arguments of "${command}" could not be read.`
        : `${flag[1]} is not a flag of "${command}", or is missing its value.`,
    );
  }
}

/** How each case that did not pass ended. */
function caseLines(cases: readonly CaseResult[]): string[] {
  return cases
    .filter((each) => !each.pass)
    .map((each) => {
      if (each.error !== undefined)
        return `  ${each.id}: ${each.error.category}${each.error.code === undefined ? '' : ` (${each.error.code})`}`;
      const failed = each.checks
        .filter((check) => !check.pass)
        .map((check) => `${check.type} ${check.target}: ${check.reason}`);
      return `  ${each.id}: failed (${failed.join('; ')})`;
    });
}

const scoreLine = (result: RunResult, threshold: number): string =>
  `Score: ${String(result.passed)} of ${String(result.total)} cases passed (${String(result.score)}); the threshold is ${String(threshold)}.`;

/**
 * Runs one command. The exit code: 0 when it did what was asked and the answer is yes, 1
 * when the answer is no (a suite that did not pass, a report refused, a gate that fails),
 * 2 when the command itself could not be understood or started.
 */
export async function main(argv: readonly string[], env: Env, io: CliIo): Promise<number> {
  const repoRoot = io.repoRoot ?? REPO_ROOT;
  const registryPath = io.registryPath ?? REGISTRY_PATH;
  const definitions = io.suites ?? SUITES;
  // pnpm runs a script in its package's folder and says where it was called from.
  const base = env['INIT_CWD'] ?? io.cwd ?? process.cwd();
  const pathOf = (path: string): string => (isAbsolute(path) ? path : resolve(base, path));
  // The key is never printed. Nothing here is given it to print; should it turn up in a
  // message all the same, it is taken out on the way.
  const key = env['EVAL_API_KEY'] ?? '';
  const withoutKey = (text: string): string =>
    key.length < MIN_KEY_LENGTH ? text : text.replaceAll(key, '[EVAL_API_KEY]');
  const say = (lines: readonly string[]): void => {
    io.out(withoutKey(lines.map((line) => `${line}\n`).join('')));
  };
  const complain = (lines: readonly string[]): void => {
    io.err(withoutKey(lines.map((line) => `${line}\n`).join('')));
  };
  const entriesNow = (): TestedEntry[] =>
    existsSync(registryPath)
      ? readRegistry(
          readFileSync(registryPath, 'utf8'),
          relative(repoRoot, registryPath).replaceAll('\\', '/'),
        )
      : [];
  const definitionFor = (job: string): SuiteDefinition | undefined =>
    definitions.find((suite) => suite.job === job);

  // A package manager may pass its own "--" along before the command.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const [command, ...rest] = args;
  if (command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }
  if (!isCommand(command)) {
    complain([`"${command.slice(0, 40)}" is not a command.`, '']);
    io.err(USAGE);
    return 2;
  }

  function list(): number {
    const entries = entriesNow();
    let failed = 0;
    if (definitions.length === 0) say(['No suite is registered yet.']);
    for (const definition of definitions) {
      try {
        const suite = loadSuite(definition, repoRoot);
        const mine = entries.filter((entry) => entry.job === suite.job);
        say([
          `${suite.job}: version ${suite.version}, ${plural(suite.cases.length, 'case', 'cases')}, threshold ${String(suite.threshold)}, dataset ${datasetHash(suite.cases)}`,
          ...(mine.length === 0 ? ['  no model is Tested yet'] : []),
          ...mine.map(
            (entry) =>
              `  Tested: ${entry.provider}/${entry.model}, ${String(entry.passed)} of ${String(entry.total)} on ${entry.testedOn}`,
          ),
        ]);
      } catch (error) {
        if (!(error instanceof EvalDataError)) throw error;
        complain([error.message]);
        failed += 1;
      }
    }
    const without = AI_JOBS.filter((job) => definitionFor(job) === undefined);
    if (without.length > 0) say([`Jobs with no suite yet: ${without.join(', ')}.`]);
    return failed === 0 ? 0 : 1;
  }

  async function gate(release: boolean): Promise<number> {
    const result = await runGate({
      repoRoot,
      suites: definitions,
      entries: entriesNow(),
      jobs: AI_JOBS,
      defaultModels: DEFAULT_JOB_MODELS,
      release,
    });
    say(result.lines);
    if (result.ok) {
      say(['The gate passed.']);
      return 0;
    }
    complain([
      ...result.problems.map((problem) => `- ${problem}`),
      `The gate failed: ${plural(result.problems.length, 'problem', 'problems')}.`,
    ]);
    return 1;
  }

  async function replay(path: string): Promise<number> {
    const report = readReportFile(pathOf(path), path);
    const definition = definitionFor(report.job);
    if (definition === undefined) {
      complain([`No suite is registered for the job "${report.job}".`]);
      return 1;
    }
    const suite = loadSuite(definition, repoRoot);
    const { result, problems } = await replayReport(report, suite);
    if (result !== undefined)
      say([
        `Replayed ${plural(result.total, 'case', 'cases')} of ${suite.job} (${suite.version}) from the recording of ${report.provider}/${report.model}.`,
        scoreLine(result, suite.threshold),
        ...caseLines(result.cases),
      ]);
    if (problems.length > 0 || result === undefined) {
      complain([...problems, 'Result: the recording does not fit the suite as it is now.']);
      return 1;
    }
    say([result.pass ? 'Result: passed, as recorded.' : 'Result: did not pass, as recorded.']);
    return result.pass ? 0 : 1;
  }

  async function recordIt(path: string): Promise<number> {
    try {
      const entry = await record({
        reportFile: pathOf(path),
        label: path,
        repoRoot,
        registryPath,
        suites: definitions,
      });
      say([
        `Recorded: ${entry.provider}/${entry.model} is Tested for ${entry.job} (${String(entry.passed)} of ${String(entry.total)}, ${entry.suiteVersion}).`,
        `Report: ${entry.report}`,
        `Registry: ${registryPath}`,
        'Commit both, and build before the product shows the badge.',
      ]);
      return 0;
    } catch (error) {
      if (!(error instanceof RecordRefused)) throw error;
      complain(['Not recorded:', ...error.problems.map((problem) => `- ${problem}`)]);
      return 1;
    }
  }

  function forgetIt(flags: Readonly<Record<string, string | undefined>>): number {
    const job = need('--job', flags['job']);
    const provider = need('--provider', flags['provider']);
    const model = need('--model', flags['model']);
    const name = `${provider}/${model}`.slice(0, 300);
    if (!forget({ job, provider, model, repoRoot, registryPath })) {
      complain([`The registry has no entry for ${name} and the job "${job.slice(0, 64)}".`]);
      return 1;
    }
    say([
      `Forgotten: ${name} is no longer Tested for ${job}. Its kept report was deleted.`,
      'Commit both changes.',
    ]);
    return 0;
  }

  function pricesOf(flags: Readonly<Record<string, string | undefined>>): ModelPrices | undefined {
    const input = flags['price-input'];
    const output = flags['price-output'];
    if ((input === undefined) !== (output === undefined))
      throw new UsageError('--price-input and --price-output go together.');
    for (const flag of ['price-cache-read', 'price-cache-write'])
      if (flags[flag] !== undefined && input === undefined)
        throw new UsageError(`--${flag} needs --price-input and --price-output.`);
    if (input === undefined || output === undefined) return undefined;
    const fresh = amount('--price-input', input);
    const cached = (flag: string): bigint => {
      const value = flags[flag];
      // Not said: priced as fresh input, which is never the cheaper guess.
      return value === undefined ? fresh : amount(`--${flag}`, value);
    };
    return {
      input: fresh,
      output: amount('--price-output', output),
      cacheRead: cached('price-cache-read'),
      cacheWrite: cached('price-cache-write'),
    };
  }

  async function run(
    flags: Readonly<Record<string, string | undefined>>,
    servers: readonly string[],
    mask: boolean,
  ): Promise<number> {
    const job = need('--job', flags['job']);
    const providerName = need('--provider', flags['provider']);
    const model = need('--model', flags['model']);
    const budgetText = need(
      '--budget-usd',
      flags['budget-usd'],
      ': a run is never made without a cap on what it may spend',
    );
    const provider = EVAL_PROVIDERS.find((each): each is EvalProvider => each === providerName);
    if (provider === undefined)
      throw new UsageError(`--provider must be one of ${EVAL_PROVIDERS.join(', ')}.`);
    const budgetMicros = amount('--budget-usd', budgetText);
    const prices = pricesOf(flags);
    let localServers: readonly LocalServer[];
    try {
      localServers = parseLocalServers(servers.join(','));
    } catch {
      throw new UsageError('--local-server must be host:port, such as ollama:11434.');
    }
    const timeoutText = flags['case-timeout-ms'];
    if (timeoutText !== undefined && !/^[1-9]\d{0,8}$/.test(timeoutText))
      throw new UsageError('--case-timeout-ms must be a whole number of milliseconds from 1.');
    const caseTimeoutMs = timeoutText === undefined ? DEFAULT_CASE_TIMEOUT_MS : Number(timeoutText);
    const definition = definitionFor(job);
    if (definition === undefined)
      throw new UsageError(`No suite is registered for the job "${job.slice(0, 64)}".`);

    const suite = loadSuite(definition, repoRoot);
    const session = createEvalGateway({
      provider,
      model,
      budgetMicros,
      apiKey: env['EVAL_API_KEY'],
      baseUrl: flags['base-url'],
      localServers,
      prices,
      mask,
      baseUrls: io.baseUrls,
      sleep: io.sleep,
      // A call that outlasted its case would only hold the command open after the verdict.
      callTimeoutMs: Math.min(caseTimeoutMs, MAX_CALL_TIMEOUT_MS),
    });
    const now = io.now ?? ((): Date => new Date());
    const startedAt = now();
    const result = await runSuite(suite, session, {
      caseTimeoutMs,
      onError: (caseId, error) => {
        const message = error instanceof Error ? error.message : 'the suite failed';
        complain([`${caseId}: ${message.slice(0, 300)}`]);
      },
    });
    const report = buildReport({
      suite,
      result,
      provider,
      model,
      mode: 'live',
      startedAt,
      finishedAt: now(),
      budgetMicros,
      spentMicros: session.spentMicros(),
      masked: mask,
    });
    const out = flags['out'];
    const file =
      out === undefined
        ? join(repoRoot, reportPath(job, provider, model).replace('evals/reports/', '.data/evals/'))
        : pathOf(out);
    const written = serializeReport(report);
    // A report is committed and read by others. No model is ever given the key, so the key
    // cannot be in one; were it ever to be, nothing is written.
    if (key.length >= MIN_KEY_LENGTH && written.includes(key)) {
      complain([
        'The report would hold the key of EVAL_API_KEY, so it was not written. Replace that key at the provider.',
      ]);
      return 1;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, written);

    const errors = result.cases.filter((each) => each.error !== undefined).length;
    say([
      `Report: ${file}`,
      scoreLine(result, suite.threshold),
      ...caseLines(result.cases),
      `Spend: ${report.spendUsd} of a budget of ${report.budgetUsd} US dollars.`,
      result.pass
        ? 'Result: passed.'
        : result.complete
          ? 'Result: did not pass.'
          : `Result: incomplete, so it cannot pass. ${plural(errors, 'case', 'cases')} ended in an error.`,
      ...(result.pass
        ? [`To mark the model Tested: pnpm --filter @repo/module-ai evals -- record ${file}`]
        : []),
    ]);
    return result.pass ? 0 : 1;
  }

  try {
    const { values, positionals } = flagsOf(command, rest);
    const text = Object.fromEntries(
      Object.entries(values).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const onePath = (): string => {
      const [path, ...more] = positionals;
      if (path === undefined || more.length > 0)
        throw new UsageError(`${command} needs the path of one report.`);
      return path;
    };
    const none = (): void => {
      if (positionals.length > 0)
        throw new UsageError(`${command} takes no argument besides its flags.`);
    };
    switch (command) {
      case 'list':
        none();
        return list();
      case 'gate':
        none();
        return await gate(values['release'] === true);
      case 'replay':
        return await replay(onePath());
      case 'record':
        return await recordIt(onePath());
      case 'forget':
        none();
        return forgetIt(text);
      case 'run': {
        none();
        const servers = values['local-server'];
        return await run(
          text,
          Array.isArray(servers) ? servers.filter((each) => typeof each === 'string') : [],
          values['mask'] === true,
        );
      }
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof EvalConfigError) {
      complain([error.message]);
      return 2;
    }
    if (error instanceof EvalDataError) {
      complain([error.message]);
      return 1;
    }
    throw error;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href)
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
  });
