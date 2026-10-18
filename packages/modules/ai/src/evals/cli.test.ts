// The command line, called as a function. Where a model is needed, it is one of the
// module's local stand-ins on loopback: nothing here reaches a real provider.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FAKE_ANTHROPIC_KEY, startFakeAnthropic } from '../../test/fake-anthropic.js';
import { startFakeOpenAi } from '../../test/fake-openai.js';
import type { FakeProvider } from '../../test/fake-provider.js';
import { main, type CliIo } from './cli.js';
import { FIXTURE_SYSTEM, fixtureSuite, type FixtureSuiteOptions } from './fixtures/suite.js';
import { makeWorkspace, type Workspace } from './fixtures/workspace.js';
import { readRegistry, renderRegistry } from './registry.js';
import { parseReport } from './report.js';

const SONNET = 'claude-sonnet-5-5';
const RUN_FILE = '.data/evals/replies/anthropic--claude-sonnet-5-5.json';
const KEPT_FILE = 'evals/reports/replies/anthropic--claude-sonnet-5-5.json';

const workspaces: Workspace[] = [];
const fakes: FakeProvider[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) workspace.remove();
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

interface Session {
  readonly made: Workspace;
  readonly out: string[];
  readonly err: string[];
  run(argv: readonly string[], env?: Readonly<Record<string, string | undefined>>): Promise<number>;
  /** Everything printed so far, and forgets it. */
  said(): string;
}

function session(
  options: {
    readonly suite?: FixtureSuiteOptions;
    readonly io?: Partial<CliIo>;
    /** A repository with no dataset in it, as this one is today. */
    readonly empty?: boolean;
  } = {},
): Session {
  const made = makeWorkspace(options.empty === true ? { dataset: null } : {});
  workspaces.push(made);
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    repoRoot: made.repoRoot,
    registryPath: made.registryPath,
    cwd: made.repoRoot,
    suites: [fixtureSuite(options.suite)],
    now: () => new Date('2026-10-10T09:00:00.000Z'),
    ...options.io,
  };
  return {
    made,
    out,
    err,
    run: (argv, env = {}) => main(argv, env, io),
    said: () => [...out.splice(0), ...err.splice(0)].join(''),
  };
}

/** The flags of a run against the stand-in for Claude, and the composition that points at it. */
async function claude(options: { readonly suite?: FixtureSuiteOptions } = {}): Promise<{
  cli: Session;
  fake: FakeProvider;
  flags: readonly string[];
  env: Readonly<Record<string, string>>;
}> {
  const fake = await startFakeAnthropic();
  fakes.push(fake);
  const cli = session({ ...options, io: { baseUrls: { anthropic: fake.origin } } });
  return {
    cli,
    fake,
    flags: [
      'run',
      '--job',
      'replies',
      '--provider',
      'anthropic',
      '--model',
      SONNET,
      '--budget-usd',
      '0.50',
      '--local-server',
      fake.hostPort,
    ],
    env: { EVAL_API_KEY: FAKE_ANTHROPIC_KEY },
  };
}

describe('the command line', () => {
  it('explains itself when asked, and when given nothing or something unknown', async () => {
    const cli = session();
    expect(await cli.run(['--help'])).toBe(0);
    expect(cli.out.join('')).toContain('Usage: evals <command>');
    expect(cli.said()).toContain('gate [--release]');
    expect(await cli.run([])).toBe(2);
    expect(cli.err.join('')).toContain('Usage: evals <command>');
    cli.said();
    expect(await cli.run(['evaluate'])).toBe(2);
    expect(cli.said()).toContain('"evaluate" is not a command.');
  });

  it('refuses a flag it does not know, a key on the command line among them', async () => {
    const cli = session();
    expect(await cli.run(['gate', '--fast'])).toBe(2);
    expect(cli.said()).toContain('--fast');
    expect(await cli.run(['run', '--api-key', 'sk-not-a-key'])).toBe(2);
    const said = cli.said();
    expect(said).toContain('--api-key');
    expect(said).not.toContain('sk-not-a-key');
  });

  it('takes its arguments after the "--" a package manager passes along', async () => {
    const cli = session({ empty: true, io: { suites: [] } });
    expect(await cli.run(['--', 'gate', '--release'])).toBe(0);
    expect(cli.said()).toBe(
      [
        'Evals gate: 0 suites, 0 Tested models.',
        'Jobs with no suite yet: automation_builder, replies, briefings, sorting. That is not a failure: each job adds its suite with its own task.',
        'Release: no job has a suite yet, so no default model is checked.',
        'The gate passed.',
        '',
      ].join('\n'),
    );
  });
});

describe('list', () => {
  it('names each suite, its dataset and the models Tested for it', async () => {
    const cli = session();
    expect(await cli.run(['list'])).toBe(0);
    const said = cli.said();
    expect(said).toContain('replies: version fixture/1, 4 cases, threshold 0.75, dataset ');
    expect(said).toContain('  no model is Tested yet');
    expect(said).toContain('Jobs with no suite yet: automation_builder, briefings, sorting.');
  });

  it('says so when there is nothing to list, and fails on a dataset that does not load', async () => {
    const empty = session({ io: { suites: [] } });
    expect(await empty.run(['list'])).toBe(0);
    expect(empty.said()).toContain('No suite is registered yet.');
    const broken = session();
    broken.made.write('evals/suites/replies/cases.json', '{}');
    expect(await broken.run(['list'])).toBe(1);
    expect(broken.said()).toContain('evals/suites/replies/cases.json: "job" must be "replies"');
  });
});

describe('gate', () => {
  it('passes on an empty registry in both strengths, and says what it found', async () => {
    const cli = session();
    expect(await cli.run(['gate'])).toBe(0);
    expect(cli.said()).toBe(
      [
        'Evals gate: 1 suite, 0 Tested models.',
        'replies (fixture/1, 4 cases, threshold 0.75): no model is Tested yet.',
        'Jobs with no suite yet: automation_builder, briefings, sorting. That is not a failure: each job adds its suite with its own task.',
        'The gate passed.',
        '',
      ].join('\n'),
    );
    expect(await cli.run(['gate', '--release'])).toBe(1);
    const said = cli.said();
    expect(said).toContain(
      'Release: the default model for replies, anthropic/claude-sonnet-5-5, is not Tested.',
    );
    expect(said).toContain('The gate failed: 1 problem.');
  });

  it('fails on a registry that was edited by hand', async () => {
    const cli = session();
    writeFileSync(cli.made.registryPath, `${renderRegistry([])}// and a note\n`);
    expect(await cli.run(['gate'])).toBe(1);
    expect(cli.said()).toContain('was edited by hand');
  });
});

describe('run', () => {
  it.each<[string, readonly string[], string]>([
    ['no job', ['run'], '--job is needed.'],
    ['no provider', ['run', '--job', 'replies'], '--provider is needed.'],
    ['no model', ['run', '--job', 'replies', '--provider', 'anthropic'], '--model is needed.'],
    [
      'no budget',
      ['run', '--job', 'replies', '--provider', 'anthropic', '--model', SONNET],
      '--budget-usd is needed: a run is never made without a cap on what it may spend.',
    ],
    [
      'a job with no suite',
      [
        'run',
        '--job',
        'sorting',
        '--provider',
        'anthropic',
        '--model',
        SONNET,
        '--budget-usd',
        '1',
      ],
      'No suite is registered for the job "sorting".',
    ],
    [
      'a provider it cannot call',
      ['run', '--job', 'replies', '--provider', 'gemini', '--model', 'g', '--budget-usd', '1'],
      '--provider must be one of anthropic, openai, openai_compatible.',
    ],
    [
      'a budget that is not an amount',
      [
        'run',
        '--job',
        'replies',
        '--provider',
        'anthropic',
        '--model',
        SONNET,
        '--budget-usd',
        '$5',
      ],
      '--budget-usd must be an amount of US dollars such as 0.50.',
    ],
    [
      'a price on its own',
      [
        'run',
        '--job',
        'replies',
        '--provider',
        'openai',
        '--model',
        'gpt',
        '--budget-usd',
        '1',
        '--price-input',
        '3',
      ],
      '--price-input and --price-output go together.',
    ],
    [
      'a cache price with no price',
      [
        'run',
        '--job',
        'replies',
        '--provider',
        'openai',
        '--model',
        'gpt',
        '--budget-usd',
        '1',
        '--price-cache-read',
        '3',
      ],
      '--price-cache-read needs --price-input and --price-output.',
    ],
    [
      'a price that is not an amount',
      [
        'run',
        '--job',
        'replies',
        '--provider',
        'openai',
        '--model',
        'gpt',
        '--budget-usd',
        '1',
        '--price-input',
        'x',
        '--price-output',
        '1',
      ],
      '--price-input must be an amount of US dollars such as 0.50.',
    ],
    [
      'a local server that is not host:port',
      [
        'run',
        '--job',
        'replies',
        '--provider',
        'anthropic',
        '--model',
        SONNET,
        '--budget-usd',
        '1',
        '--local-server',
        'localhost',
      ],
      '--local-server must be host:port, such as ollama:11434.',
    ],
    [
      'a deadline that is not a count',
      [
        'run',
        '--job',
        'replies',
        '--provider',
        'anthropic',
        '--model',
        SONNET,
        '--budget-usd',
        '1',
        '--case-timeout-ms',
        'soon',
      ],
      '--case-timeout-ms must be a whole number of milliseconds from 1.',
    ],
    [
      'something after its flags',
      [
        'run',
        'now',
        '--job',
        'replies',
        '--provider',
        'anthropic',
        '--model',
        SONNET,
        '--budget-usd',
        '1',
      ],
      'run takes no argument besides its flags.',
    ],
  ])('refuses %s before anything is called', async (_name, argv, message) => {
    const cli = session();
    expect(await cli.run(argv, { EVAL_API_KEY: FAKE_ANTHROPIC_KEY })).toBe(2);
    expect(cli.said()).toContain(message);
  });

  it('refuses to start without a key in EVAL_API_KEY, or without a price', async () => {
    const { cli, flags, fake } = await claude();
    expect(await cli.run(flags)).toBe(2);
    expect(cli.said()).toContain('EVAL_API_KEY is not set: anthropic needs a key.');
    const unpriced = [
      'run',
      '--job',
      'replies',
      '--provider',
      'openai',
      '--model',
      'gpt-x',
      '--budget-usd',
      '1',
    ];
    expect(await cli.run(unpriced, { EVAL_API_KEY: 'sk-fixture' })).toBe(2);
    expect(cli.said()).toContain('No price is known for openai/gpt-x.');
    expect(fake.requests).toHaveLength(0);
  });

  it('runs the suite against the model, writes the report and says how it went', async () => {
    const { cli, fake, flags, env } = await claude();
    expect(await cli.run(flags, env)).toBe(0);
    const file = join(cli.made.repoRoot, RUN_FILE);
    const said = cli.said();
    expect(said).toContain(`Report: ${file}\n`);
    expect(said).toContain('Score: 3 of 4 cases passed (0.75); the threshold is 0.75.\n');
    expect(said).toMatch(/Spend: 0\.\d{6} of a budget of 0\.500000 US dollars\.\n/);
    expect(said).toContain('Result: passed.\n');
    expect(said).toContain(`record ${file}`);
    expect(said).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(fake.requests).toHaveLength(4);

    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(text).not.toContain(fake.hostPort);
    expect(parseReport(text, RUN_FILE)).toMatchObject({
      job: 'replies',
      provider: 'anthropic',
      model: SONNET,
      mode: 'live',
      startedAt: '2026-10-10T09:00:00.000Z',
      passed: 3,
      pass: true,
      complete: true,
      budgetUsd: '0.500000',
      masked: false,
    });
    // A run marks nothing Tested: only `record` does.
    expect(readFileSync(cli.made.registryPath, 'utf8')).toBe(renderRegistry([]));
    expect(existsSync(join(cli.made.repoRoot, KEPT_FILE))).toBe(false);
  });

  it('exits non-zero when the suite did not pass', async () => {
    const { cli, flags, env } = await claude({ suite: { threshold: 0.9 } });
    expect(await cli.run(flags, env)).toBe(1);
    const said = cli.said();
    expect(said).toContain('Score: 3 of 4 cases passed (0.75); the threshold is 0.9.');
    expect(said).toContain('Result: did not pass.');
    expect(said).toContain(
      '  uses-the-name: failed (contains text: the text does not contain what was expected)',
    );
    expect(said).not.toContain('record ');
  });

  it('exits non-zero when the run was incomplete, as when the budget ran out', async () => {
    const { cli, fake, flags, env } = await claude();
    const tight = flags.map((flag) => (flag === '0.50' ? '0.000001' : flag));
    expect(await cli.run(tight, env)).toBe(1);
    const said = cli.said();
    expect(said).toContain('Result: incomplete, so it cannot pass. 4 cases ended in an error.');
    expect(said).toContain('  greets: paused');
    expect(said).toContain('Spend: 0.000000 of a budget of 0.000001 US dollars.');
    expect(fake.requests).toHaveLength(0);
  });

  it('writes the report where it is told, relative to where the command was called', async () => {
    const { cli, flags, env } = await claude();
    expect(await cli.run([...flags, '--out', 'out/mine.json'], env)).toBe(0);
    expect(existsSync(join(cli.made.repoRoot, 'out/mine.json'))).toBe(true);
    expect(existsSync(join(cli.made.repoRoot, RUN_FILE))).toBe(false);
  });

  it('refuses a local stand-in until it is named with --local-server', async () => {
    const fake = await startFakeOpenAi(null);
    fakes.push(fake);
    const cli = session();
    const flags = [
      'run',
      '--job',
      'replies',
      '--provider',
      'openai_compatible',
      '--model',
      'fixture-model',
      '--budget-usd',
      '0',
      '--base-url',
      `${fake.origin}/v1`,
      '--price-input',
      '0',
      '--price-output',
      '0',
      '--price-cache-read',
      '0',
      '--price-cache-write',
      '0',
      '--mask',
    ];
    expect(await cli.run(flags)).toBe(2);
    expect(cli.said()).toContain('must be named with --local-server host:port');
    expect(fake.requests).toHaveLength(0);

    expect(
      await cli.run([...flags, '--local-server', fake.hostPort, '--case-timeout-ms', '60000']),
    ).toBe(0);
    expect(cli.said()).toContain('Spend: 0.000000 of a budget of 0.000000 US dollars.');
    expect(fake.requests).toHaveLength(4);
    expect(fake.requests[2]?.body).toContain('[email]');
    const file = join(
      cli.made.repoRoot,
      '.data/evals/replies/openai_compatible--fixture-model.json',
    );
    expect(parseReport(readFileSync(file, 'utf8'), 'run.json')).toMatchObject({
      provider: 'openai_compatible',
      model: 'fixture-model',
      masked: true,
      pass: true,
    });
  });

  it('says what went wrong in the suite, without failing the whole command', async () => {
    const { fake, env, flags } = await claude();
    const broken = session({
      io: {
        baseUrls: { anthropic: fake.origin },
        suites: [
          {
            ...fixtureSuite(),
            run: () => Promise.reject(new Error('The job broke.')),
          },
        ],
      },
    });
    expect(await broken.run(flags, env)).toBe(1);
    const said = broken.said();
    expect(said).toContain('greets: The job broke.');
    expect(said).toContain('  greets: run_error');
    expect(said).toContain('Result: incomplete, so it cannot pass. 4 cases ended in an error.');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('replay, record and gate, after a run', () => {
  async function ran(options: { readonly suite?: FixtureSuiteOptions } = {}): Promise<{
    cli: Session;
    file: string;
    requests: number;
  }> {
    const { cli, fake, flags, env } = await claude(options);
    expect(await cli.run(flags, env)).toBe(0);
    cli.said();
    return { cli, file: join(cli.made.repoRoot, RUN_FILE), requests: fake.requests.length };
  }

  it('replays a report with no key and no network, and agrees with it', async () => {
    const { cli, file } = await ran();
    const before = fakes[0]?.requests.length;
    expect(await cli.run(['replay', file])).toBe(0);
    expect(cli.said()).toBe(
      [
        'Replayed 4 cases of replies (fixture/1) from the recording of anthropic/claude-sonnet-5-5.',
        'Score: 3 of 4 cases passed (0.75); the threshold is 0.75.',
        '  uses-the-name: failed (contains text: the text does not contain what was expected)',
        'Result: passed, as recorded.',
        '',
      ].join('\n'),
    );
    expect(fakes[0]?.requests.length).toBe(before);
  });

  it('fails a replay through a prompt that changed, and one against another dataset', async () => {
    const { cli, file } = await ran();
    const changed = session({
      suite: { system: `${FIXTURE_SYSTEM}?` },
      io: { repoRoot: cli.made.repoRoot },
    });
    expect(await changed.run(['replay', file])).toBe(1);
    expect(changed.said()).toContain(
      '4 cases are stale: the prompt or the code changed since the run',
    );

    cli.made.write(
      'evals/suites/replies/cases.json',
      readFileSync(join(cli.made.repoRoot, 'evals/suites/replies/cases.json'), 'utf8').replace(
        'Hi there',
        'Hi there!',
      ),
    );
    expect(await cli.run(['replay', file])).toBe(1);
    expect(cli.said()).toContain('The dataset has changed since the run');
  });

  it("needs the report's path, and says when there is no such report or suite", async () => {
    const cli = session();
    expect(await cli.run(['replay'])).toBe(2);
    expect(cli.said()).toContain('replay needs the path of one report.');
    expect(await cli.run(['record'])).toBe(2);
    expect(cli.said()).toContain('record needs the path of one report.');
    expect(await cli.run(['replay', 'nowhere.json'])).toBe(1);
    expect(cli.said()).toContain('nowhere.json: the report is missing.');
    expect(await cli.run(['record', 'nowhere.json'])).toBe(1);
    expect(cli.said()).toContain('nowhere.json: the report is missing.');
  });

  it('records a passing run, after which the gate and the list name the model', async () => {
    const { cli, file } = await ran();
    expect(await cli.run(['gate', '--release'])).toBe(1);
    cli.said();

    expect(await cli.run(['record', file])).toBe(0);
    expect(cli.said()).toBe(
      [
        'Recorded: anthropic/claude-sonnet-5-5 is Tested for replies (3 of 4, fixture/1).',
        `Report: ${KEPT_FILE}`,
        `Registry: ${cli.made.registryPath}`,
        'Commit both, and build before the product shows the badge.',
        '',
      ].join('\n'),
    );
    const entries = readRegistry(readFileSync(cli.made.registryPath, 'utf8'), 'tested.gen.ts');
    expect(entries).toMatchObject([
      {
        job: 'replies',
        provider: 'anthropic',
        model: SONNET,
        passed: 3,
        total: 4,
        testedOn: '2026-10-10',
      },
    ]);
    expect(readFileSync(join(cli.made.repoRoot, KEPT_FILE), 'utf8')).toBe(
      readFileSync(file, 'utf8'),
    );

    expect(await cli.run(['gate', '--release'])).toBe(0);
    const gate = cli.said();
    expect(gate).toContain('Evals gate: 1 suite, 1 Tested model.');
    expect(gate).toContain('Release: the default model of every job with a suite is Tested');
    expect(await cli.run(['list'])).toBe(0);
    expect(cli.said()).toContain('  Tested: anthropic/claude-sonnet-5-5, 3 of 4 on 2026-10-10');
  });

  it('refuses to record a run that did not pass, and says why', async () => {
    const { cli, flags, env } = await claude({ suite: { threshold: 0.9 } });
    expect(await cli.run(flags, env)).toBe(1);
    cli.said();
    expect(await cli.run(['record', RUN_FILE])).toBe(1);
    const said = cli.said();
    expect(said).toContain('Not recorded:');
    expect(said).toContain(
      'The run did not pass: 3 of 4 cases passed (0.75) and the threshold was 0.9.',
    );
    expect(readFileSync(cli.made.registryPath, 'utf8')).toBe(renderRegistry([]));
  });

  it('reads a path as given from where the package manager was called', async () => {
    const { cli, file } = await ran();
    expect(file.endsWith('claude-sonnet-5-5.json')).toBe(true);
    expect(await cli.run(['replay', RUN_FILE], { INIT_CWD: cli.made.repoRoot })).toBe(0);
    expect(
      await cli.run(['replay', RUN_FILE], { INIT_CWD: join(cli.made.repoRoot, 'evals') }),
    ).toBe(1);
  });
});

describe('the rest of what the command line says', () => {
  it('names the provider error a case ended in', async () => {
    const { cli, fake, flags, env } = await claude();
    // The stand-in is on a private address, and this time nobody named it.
    const unlisted = flags.slice(0, flags.indexOf('--local-server'));
    expect(await cli.run(unlisted, env)).toBe(1);
    const said = cli.said();
    expect(said).toContain('  greets: provider_error (blocked_address)');
    expect(said).toContain('Result: incomplete, so it cannot pass. 4 cases ended in an error.');
    expect(said).toContain('Spend: 0.000000 of a budget of 0.500000 US dollars.');
    expect(fake.requests).toHaveLength(0);
  });

  it('prices cached tokens as fresh input when their price is not given', async () => {
    const fake = await startFakeOpenAi(null);
    fakes.push(fake);
    const cli = session();
    const flags = [
      'run',
      '--job',
      'replies',
      '--provider',
      'openai_compatible',
      '--model',
      'fixture-model',
      '--budget-usd',
      '1',
      '--base-url',
      `${fake.origin}/v1`,
      '--local-server',
      fake.hostPort,
      '--price-input',
      '3',
      '--price-output',
      '12',
    ];
    expect(await cli.run(flags)).toBe(0);
    // The stand-in reports 19 fresh input tokens and 10 output tokens for each of 4 calls.
    expect(cli.said()).toContain('Spend: 0.000708 of a budget of 1.000000 US dollars.');
  });

  it('says so when a replay does not pass, as it did not when it was recorded', async () => {
    const { cli, flags, env } = await claude({ suite: { threshold: 0.9 } });
    expect(await cli.run(flags, env)).toBe(1);
    cli.said();
    expect(await cli.run(['replay', RUN_FILE])).toBe(1);
    expect(cli.said()).toContain('Result: did not pass, as recorded.');
  });

  it('cannot replay a report whose job has no suite', async () => {
    const { cli, flags, env } = await claude();
    expect(await cli.run(flags, env)).toBe(0);
    const none = session({
      io: { suites: [], repoRoot: cli.made.repoRoot, cwd: cli.made.repoRoot },
    });
    expect(await none.run(['replay', RUN_FILE])).toBe(1);
    expect(none.said()).toContain('No suite is registered for the job "replies".');
  });

  it('reads an empty registry where there is no registry file yet', async () => {
    const cli = session();
    rmSync(cli.made.registryPath);
    expect(await cli.run(['gate'])).toBe(0);
    expect(cli.said()).toContain('Evals gate: 1 suite, 0 Tested models.');
  });

  it('refuses arguments it cannot read at all, and a command given something extra', async () => {
    const cli = session();
    expect(await cli.run(['gate', '--=x'])).toBe(2);
    expect(cli.said()).toContain('The arguments of "gate" could not be read.');
    expect(await cli.run(['run', '--job'])).toBe(2);
    expect(cli.said()).toContain('--job is not a flag of "run", or is missing its value.');
    expect(await cli.run(['list', 'everything'])).toBe(2);
    expect(cli.said()).toContain('list takes no argument besides its flags.');
    expect(await cli.run(['replay', 'a.json', 'b.json'])).toBe(2);
    expect(cli.said()).toContain('replay needs the path of one report.');
  });

  it('works on this repository as it is, with nothing put in its place', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (text) => out.push(text), err: (text) => err.push(text) };
    expect(await main(['gate'], {}, io)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('')).toContain('The gate passed.');
    expect(await main(['list'], {}, io)).toBe(0);
    // In the strength a release asks for, it is held back by the default models nobody has
    // evaluated yet, and says so: replies and sorting (which extraction runs as) each have
    // a suite, and no live run has been made.
    expect(await main(['gate', '--release'], {}, io)).toBe(1);
    expect(err.join('')).toBe(
      '- Release: the default model for replies, anthropic/claude-sonnet-5-5, is not Tested.\n- Release: the default model for sorting, anthropic/claude-haiku-4-5-20251001, is not Tested.\nThe gate failed: 2 problems.\n',
    );
  });
});

describe('the key', () => {
  it('is taken out of anything the command prints, should it ever turn up there', async () => {
    const { fake, flags, env } = await claude();
    const leaking = session({
      io: {
        baseUrls: { anthropic: fake.origin },
        suites: [
          {
            ...fixtureSuite(),
            run: () => Promise.reject(new Error(`A broken suite printed ${FAKE_ANTHROPIC_KEY}.`)),
          },
        ],
      },
    });
    expect(await leaking.run(flags, env)).toBe(1);
    const said = leaking.said();
    expect(said).toContain('greets: A broken suite printed [EVAL_API_KEY].');
    expect(said).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it('is never written to a report: a report that would hold it is not written at all', async () => {
    const { fake, flags, env } = await claude();
    const leaking = session({
      io: {
        baseUrls: { anthropic: fake.origin },
        suites: [
          {
            ...fixtureSuite(),
            run: () => Promise.resolve({ outcome: 'ok', text: `Hello ${FAKE_ANTHROPIC_KEY}` }),
          },
        ],
      },
    });
    expect(await leaking.run(flags, env)).toBe(1);
    const said = leaking.said();
    expect(said).toContain('The report would hold the key of EVAL_API_KEY, so it was not written.');
    expect(said).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(existsSync(join(leaking.made.repoRoot, RUN_FILE))).toBe(false);
  });

  it('is not looked for when it is too short to be told from an ordinary word', async () => {
    const fake = await startFakeOpenAi('ok');
    fakes.push(fake);
    const cli = session();
    const flags = [
      'run',
      '--job',
      'replies',
      '--provider',
      'openai_compatible',
      '--model',
      'fixture-model',
      '--budget-usd',
      '0',
      '--base-url',
      `${fake.origin}/v1`,
      '--local-server',
      fake.hostPort,
      '--price-input',
      '0',
      '--price-output',
      '0',
    ];
    expect(await cli.run(flags, { EVAL_API_KEY: 'ok' })).toBe(0);
    expect(cli.said()).toContain('Result: passed.');
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer ok');
  });
});

describe('forget', () => {
  const which = ['--job', 'replies', '--provider', 'anthropic', '--model', SONNET];

  it('takes a model out of the Tested models, after which the gate no longer checks it', async () => {
    const { cli, flags, env } = await claude();
    expect(await cli.run(flags, env)).toBe(0);
    expect(await cli.run(['record', RUN_FILE])).toBe(0);
    // The prompt changes: the recording is stale, and the gate fails until someone decides.
    const changed = session({
      suite: { system: `${FIXTURE_SYSTEM} Be brief.` },
      io: { repoRoot: cli.made.repoRoot, registryPath: cli.made.registryPath },
    });
    expect(await changed.run(['gate'])).toBe(1);
    changed.said();

    expect(await changed.run(['forget', ...which])).toBe(0);
    expect(changed.said()).toBe(
      [
        'Forgotten: anthropic/claude-sonnet-5-5 is no longer Tested for replies. Its kept report was deleted.',
        'Commit both changes.',
        '',
      ].join('\n'),
    );
    expect(readFileSync(cli.made.registryPath, 'utf8')).toBe(renderRegistry([]));
    expect(existsSync(join(cli.made.repoRoot, KEPT_FILE))).toBe(false);
    expect(await changed.run(['gate'])).toBe(0);
    expect(changed.said()).toContain('Evals gate: 1 suite, 0 Tested models.');
  });

  it('says so when there is nothing to forget, and needs to be told which model', async () => {
    const cli = session();
    expect(await cli.run(['forget', ...which])).toBe(1);
    expect(cli.said()).toContain(
      'The registry has no entry for anthropic/claude-sonnet-5-5 and the job "replies".',
    );
    expect(await cli.run(['forget', '--job', 'replies', '--provider', 'anthropic'])).toBe(2);
    expect(cli.said()).toContain('--model is needed.');
    expect(await cli.run(['forget', '--job', 'replies'])).toBe(2);
    expect(cli.said()).toContain('--provider is needed.');
    expect(await cli.run(['forget'])).toBe(2);
    expect(cli.said()).toContain('--job is needed.');
    expect(await cli.run(['forget', 'replies', ...which])).toBe(2);
    expect(cli.said()).toContain('forget takes no argument besides its flags.');
  });
});
