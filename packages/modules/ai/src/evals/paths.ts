// Where the harness finds the repository it is part of, from its own place in it:
// packages/modules/ai/src/evals when run from source, packages/modules/ai/dist/evals when
// built. Both are five folders down from the root.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository's root: datasets and reports are under its `evals` folder. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The registry of Tested models, which is a source file: the build compiles it in. */
export const REGISTRY_PATH = join(REPO_ROOT, 'packages/modules/ai/src/evals/tested.gen.ts');
