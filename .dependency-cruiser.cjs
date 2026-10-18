/**
 * Module boundaries, checked by `pnpm deps:check`.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports hide the real dependency direction. Extract the shared part.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'modules-use-public-entry',
      severity: 'error',
      comment:
        'A module may use another module only through its public entry point (src/index.ts), never its internals.',
      from: { path: '^packages/modules/([^/]+)/' },
      to: {
        path: '^packages/modules/[^/]+/',
        pathNot: ['^packages/modules/$1/', '^packages/modules/[^/]+/src/index\\.ts$'],
      },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      comment: 'Shared packages must not depend on an application.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'dashboard-never-imports-server',
      severity: 'error',
      comment: 'The dashboard talks to the server through the API and the generated SDK only.',
      from: { path: '^apps/dashboard/' },
      to: { path: '^apps/server/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every import must resolve to a real file or package.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dev-dependencies-in-source',
      severity: 'error',
      comment: 'Production code may not import development dependencies.',
      // packages/modules/* and packages/adapters/* sit one folder deeper.
      from: {
        path: '^(apps|packages)/((modules|adapters)/)?[^/]+/src/',
        pathNot: '\\.test\\.tsx?$',
      },
      to: { dependencyTypes: ['npm-dev'], pathNot: 'node_modules/@types/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Our own build and test output only: a package in node_modules often keeps its code in
    // dist/, and excluding that would hide imports of it from the rules above.
    exclude: {
      path: '^(apps/[^/]+|packages/((modules|adapters)/)?[^/]+|e2e)/(dist|coverage|reports|playwright-report|test-results|\\.stryker-tmp)/',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
