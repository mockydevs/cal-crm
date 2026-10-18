// On a CI machine (two cores on GitHub's runner) the long component tests that click through
// the workflow builder take several seconds, and an element they wait for can take more than
// Testing Library's one second to appear. The waits are longer there; what is asserted is not.
import { configure } from '@testing-library/react';

if (process.env['CI'] === 'true') configure({ asyncUtilTimeout: 5_000 });
