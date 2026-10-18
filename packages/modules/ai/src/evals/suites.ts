// Every job's eval suite, in one list. Each job adds its own here, with its dataset in
// evals/suites/<job>/cases.json, when its task builds it.
//
// The harness's own fixture suite (fixtures/suite.ts) is for its tests and is deliberately
// not here.
import { sortingSuite } from '../extraction-evals.js';
import { repliesSuite } from '../reply-draft-evals.js';
import type { SuiteDefinition } from './types.js';

export const SUITES: readonly SuiteDefinition[] = [repliesSuite, sortingSuite];
