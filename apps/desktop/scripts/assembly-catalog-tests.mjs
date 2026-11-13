export const FULL_ASSEMBLY_CATALOG_TESTS = Object.freeze([
  'src/features/assembly-graph/__tests__/inference/synthetic-assembly-catalog.test.ts',
]);

const MANUAL_WRITER =
  'src/features/assembly-graph/__tests__/inference/generate-browser-data.test.ts';

export function assemblyCatalogExclusions(argv = process.argv, env = process.env) {
  const explicitlyNames = (file) =>
    argv.some((arg) => arg.replaceAll('\\', '/').endsWith(file.split('/').at(-1)));
  return [
    ...(env.DNAFORGE_FULL_ASSEMBLY_CATALOG_TESTS === '1' ||
    FULL_ASSEMBLY_CATALOG_TESTS.some(explicitlyNames)
      ? []
      : FULL_ASSEMBLY_CATALOG_TESTS),
    ...(explicitlyNames(MANUAL_WRITER) ? [] : [MANUAL_WRITER]),
  ];
}

export function assemblyCatalogBase(baseSha, changedPaths = []) {
  const globalInput = changedPaths.some(
    (file) =>
      /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|nx\.json|\.nvmrc|\.npmrc|tsconfig[^/]*\.json)$/u.test(
        file
      ) ||
      /^apps\/desktop\/(?:package\.json|vitest[^/]*\.[cm]?[jt]s|tsconfig[^/]*\.json|src\/test\/)/u.test(
        file
      ) ||
      [
        'scripts/ci-desktop-unit-batches.mjs',
        'scripts/ci-run-authority-unit-tests.sh',
        'apps/desktop/scripts/assembly-catalog-tests.mjs',
        'apps/desktop/scripts/run-tests.mjs',
      ].includes(file)
  );
  return globalInput ? undefined : baseSha;
}
