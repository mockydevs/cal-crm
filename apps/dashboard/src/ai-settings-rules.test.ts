import { i18n } from '@lingui/core';
import { aiTestOutcomes, type AiConnection, type AiSettings } from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addressProblem,
  addressProblemText,
  choiceOf,
  CLAUDE_MODEL_NAMES,
  failureText,
  formatDollars,
  hostAndPort,
  isProvider,
  jobLabel,
  modelName,
  operatorCanAllow,
  outcomeText,
  ownConnection,
  parseChoice,
  percentOf,
  plainAmount,
  secondsOf,
  settingsInput,
  sharedProvider,
} from './ai-settings-rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({
  enabled: true,
  keySource: 'own',
  monthlyLimit: '50.0000',
  atLimit: 'pause',
  maskContactDetails: false,
  requestLogDays: 30,
  backup: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', readiness: 'ready' },
  jobs: [
    {
      job: 'automation_builder',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      isDefault: true,
      tested: false,
      readiness: 'ready',
    },
    {
      job: 'replies',
      provider: 'openai_compatible',
      model: 'llama3.2',
      isDefault: false,
      tested: false,
      readiness: 'price_needed',
    },
    {
      job: 'briefings',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      isDefault: true,
      tested: false,
      readiness: 'ready',
    },
    {
      job: 'sorting',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      isDefault: true,
      tested: false,
      readiness: 'ready',
    },
  ],
  models: [],
  limitReachedAt: null,
  revision: 'a'.repeat(64),
  ...patch,
});

describe('a model’s name', () => {
  it('is Anthropic’s own for Claude, and the id for anything else', () => {
    expect(modelName('anthropic', 'claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelName('anthropic', 'claude-fable-5-1')).toBe('Claude Fable 5.1');
    expect(modelName('anthropic', 'claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelName('anthropic', 'claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    expect(modelName('anthropic', 'claude-haiku-4-5')).toBe('Claude Haiku 4.5');
    // A Claude model this version does not know is shown as it is, not guessed at.
    expect(modelName('anthropic', 'claude-next-9')).toBe('claude-next-9');
    // Another provider's model that happens to share an id is that provider's.
    expect(modelName('openai_compatible', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelName('openai', 'gpt-fixture')).toBe('gpt-fixture');
    expect(CLAUDE_MODEL_NAMES).toEqual([
      'Claude Opus 5.5',
      'Claude Sonnet 5.5',
      'Claude Haiku 4.5',
    ]);
  });
});

describe('a choice in a select', () => {
  it('names a provider and a model, and reads back the same, slashes in the model included', () => {
    expect(choiceOf('anthropic', 'claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(parseChoice('anthropic/claude-opus-5-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
    expect(parseChoice(choiceOf('openai_compatible', 'meta/llama-3:8b'))).toEqual({
      provider: 'openai_compatible',
      model: 'meta/llama-3:8b',
    });
  });

  it.each(['none', '', '/model', 'anthropic/', 'gemini/gemini-pro', 'anthropic'])(
    'is nothing for %j',
    (value) => {
      expect(parseChoice(value)).toBeUndefined();
    },
  );

  it('knows the providers there is an adapter for', () => {
    expect(['anthropic', 'openai', 'openai_compatible'].every(isProvider)).toBe(true);
    expect(isProvider('gemini')).toBe(false);
    expect(isProvider('toString')).toBe(false);
  });
});

describe('what is sent to save', () => {
  it('is everything as it is, with the change, at the revision that was read', () => {
    expect(settingsInput(settings(), { maskContactDetails: true })).toEqual({
      enabled: true,
      keySource: 'own',
      monthlyLimit: '50',
      atLimit: 'pause',
      maskContactDetails: true,
      requestLogDays: 30,
      backup: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      jobs: {
        automation_builder: null,
        replies: { provider: 'openai_compatible', model: 'llama3.2' },
        briefings: null,
        sorting: null,
      },
      revision: 'a'.repeat(64),
    });
  });

  it('keeps no limit as no limit, and no backup as no backup', () => {
    expect(settingsInput(settings({ monthlyLimit: null, backup: null }))).toMatchObject({
      monthlyLimit: null,
      backup: null,
    });
  });

  it('leaves a choice on a provider there is no adapter for to the default', () => {
    const [first, ...rest] = settings().jobs;
    if (first === undefined) throw new Error('No job.');
    const legacy = settings({
      jobs: [{ ...first, provider: 'gemini', model: 'gemini-pro', isDefault: false }, ...rest],
      backup: { provider: 'gemini', model: 'gemini-pro', readiness: 'no_key' },
    });
    expect(settingsInput(legacy)).toMatchObject({
      backup: null,
      jobs: { automation_builder: null },
    });
  });
});

describe('an amount', () => {
  it.each([
    ['50.0000', '50'],
    ['12.5000', '12.50'],
    ['12.3400', '12.34'],
    ['0.0050', '0.005'],
    ['0.0000', '0'],
    ['7', '7'],
  ])('%s is written %s, without the zeros nobody typed', (amount, plain) => {
    expect(plainAmount(amount)).toBe(plain);
  });

  it.each([
    ['18.400000', '$18.40'],
    ['1234.5', '$1,234.50'],
    ['0', '$0.00'],
    ['0.000000', '$0.00'],
    ['0.05', '$0.05'],
    ['0.0123', '$0.0123'],
    ['0.004200', '$0.0042'],
    ['0.000100', '$0.0001'],
    // Smaller than can be shown, and still not nothing.
    ['0.000042', '<$0.0001'],
    ['0.000001', '<$0.0001'],
  ])('%s dollars reads %s', (amount, text) => {
    expect(formatDollars(amount, 'en')).toBe(text);
  });

  it('is a share of the limit, from 0 to 100', () => {
    expect(percentOf('18.4', '50')).toBe(37);
    expect(percentOf('0', '50')).toBe(0);
    expect(percentOf('50', '50')).toBe(100);
    expect(percentOf('75', '50')).toBe(100);
    // A limit of nothing is always reached.
    expect(percentOf('0', '0')).toBe(100);
  });

  it('writes how long a provider took to a tenth of a second', () => {
    expect(secondsOf(812, 'en')).toBe('0.8');
    expect(secondsOf(12_340, 'en')).toBe('12.3');
    expect(secondsOf(0, 'en')).toBe('0.0');
  });
});

describe('a model server’s address', () => {
  it.each([
    ['http://ollama:11434/v1', 'ollama:11434'],
    ['  http://192.168.1.20:8080/v1  ', '192.168.1.20:8080'],
    ['http://localhost/v1', 'localhost:80'],
    ['https://models.example.com/v1', 'models.example.com:443'],
    ['http://[::1]:1234/v1', '[::1]:1234'],
    ['HTTP://Ollama:11434', 'ollama:11434'],
  ])('%s is listed by its operator as %s', (address, listed) => {
    expect(hostAndPort(address)).toBe(listed);
  });

  it.each(['ollama:11434', 'not an address', '', 'ftp://ollama/models', 'file:///etc/passwd'])(
    'has no host and port to list when it is %j',
    (address) => {
      expect(hostAndPort(address)).toBeUndefined();
    },
  );

  it('is refused for a reason the API names, each with words of the page’s own', () => {
    expect(addressProblem('address_not_https')).toBe('not_https');
    expect(addressProblem('address_port_not_allowed')).toBe('port_not_allowed');
    expect(addressProblem('address_has_credentials')).toBe('has_credentials');
    expect(addressProblem('address_has_query')).toBe('has_query');
    expect(addressProblem('address_not_a_url')).toBe('not_a_url');
    expect(addressProblem('too_long')).toBeUndefined();
    expect(addressProblem('not_https')).toBeUndefined();
    for (const text of Object.values(addressProblemText))
      expect(i18n._(text).length).toBeGreaterThan(20);
  });

  it('can be let through by whoever runs the install only when the rule is about where it is', () => {
    expect(operatorCanAllow('not_https')).toBe(true);
    expect(operatorCanAllow('port_not_allowed')).toBe(true);
    expect(operatorCanAllow('not_a_url')).toBe(false);
    expect(operatorCanAllow('has_credentials')).toBe(false);
    expect(operatorCanAllow('has_query')).toBe(false);
  });
});

describe('the words for a test’s outcome', () => {
  it('has a sentence for every way a test can end but working', () => {
    expect(Object.keys(outcomeText).sort()).toEqual(
      aiTestOutcomes.filter((outcome) => outcome !== 'ok').sort(),
    );
    for (const text of Object.values(outcomeText)) {
      expect(i18n._(text.what).length).toBeGreaterThan(20);
      if (text.fix !== undefined) expect(i18n._(text.fix).length).toBeGreaterThan(10);
    }
  });

  it('says what to do for the things a person can fix', () => {
    expect(i18n._(outcomeText.authentication.what)).toBe("The provider didn't accept this key.");
    expect(i18n._(outcomeText.billing.what)).toContain('no credit');
    expect(i18n._(outcomeText.not_found.fix ?? outcomeText.not_found.what)).toContain(
      "model's name",
    );
    expect(i18n._(outcomeText.blocked_address.fix ?? outcomeText.blocked_address.what)).toContain(
      'AI_LOCAL_SERVERS',
    );
    expect(i18n._(outcomeText.unavailable.what)).toContain("couldn't reach");
    expect(i18n._(outcomeText.price_unknown.fix ?? outcomeText.price_unknown.what)).toContain(
      'it can be zero',
    );
    expect(outcomeText.not_supported.fix).toBeUndefined();
  });

  it('gives a failed call the same words, and its own for one cut off', () => {
    expect(failureText(null)).toBeUndefined();
    expect(failureText('authentication')).toBe(outcomeText.authentication.what);
    expect(failureText('unavailable')).toBe(outcomeText.unavailable.what);
    const cutOff = failureText('abandoned');
    expect(cutOff === undefined ? '' : i18n._(cutOff)).toBe(
      'The call was cut off before it finished.',
    );
    // A category from a newer server, or a word that is not a category at all.
    expect(failureText('brand_new_reason')).toBeUndefined();
    expect(failureText('ok')).toBeUndefined();
    expect(failureText('toString')).toBeUndefined();
  });
});

describe('a job’s name in the list of calls', () => {
  it('is the job’s, a test’s own, or nothing for a job this version does not know', () => {
    const name = (job: string): string | undefined => {
      const label = jobLabel(job);
      return label === undefined ? undefined : i18n._(label);
    };
    expect(name('replies')).toBe('Replies and messages');
    expect(name('sorting')).toBe('Sorting and filling fields');
    expect(name('connection_test')).toBe('Connection test');
    expect(name('search')).toBeUndefined();
    expect(name('constructor')).toBeUndefined();
  });
});

describe('the connections of a page', () => {
  const connection = (patch: Partial<AiConnection>): AiConnection => ({
    id: 'aic_01k8e2wzr0e008000000000001',
    provider: 'anthropic',
    owner: 'business',
    canManage: true,
    hasKey: true,
    keyLast4: 'a1f3',
    baseUrl: null,
    model: null,
    status: 'working',
    lastTest: null,
    addedBy: 'Dana Brooks',
    createdAt: '2026-10-02T09:00:00.000Z',
    ...patch,
  });

  it('has one of its own for a provider at most; the agency’s is not its own', () => {
    const own = connection({});
    const shared = connection({ provider: 'openai', owner: 'agency', canManage: false });
    expect(ownConnection([shared, own], 'anthropic')).toBe(own);
    expect(ownConnection([shared, own], 'openai')).toBeUndefined();
    expect(ownConnection([], 'anthropic')).toBeUndefined();
  });
});

describe('a backup on the same provider as every job', () => {
  it('is said, because one outage would then stop everything', () => {
    const claudeOnly = settings({
      jobs: settings().jobs.map((job) => ({ ...job, provider: 'anthropic' })),
    });
    expect(sharedProvider(claudeOnly)).toBe('anthropic');
  });

  it('is not said when a job is elsewhere, the backup is elsewhere, or there is no backup', () => {
    expect(sharedProvider(settings())).toBeUndefined();
    expect(
      sharedProvider(
        settings({
          jobs: settings().jobs.map((job) => ({ ...job, provider: 'anthropic' })),
          backup: { provider: 'openai_compatible', model: 'llama3.2', readiness: 'ready' },
        }),
      ),
    ).toBeUndefined();
    expect(sharedProvider(settings({ backup: null }))).toBeUndefined();
  });
});
