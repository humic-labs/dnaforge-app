const {
  RELEASE_POLICY,
  RELEASE_SOURCES_SCHEMA,
  releaseSourceViolation,
  neverImportableViolation,
  isDependencySourcePath,
} = require('./release-bundle-boundary.mjs');

const REQUIRED_RECEIPTS = [
  ['main', 'out/main/release-sources.main.json'],
  ['preload', 'out/preload/release-sources.preload.json'],
  ['renderer', 'out/renderer/release-sources.renderer.json'],
];
const WORKER_RECEIPT =
  /^out\/renderer\/(?:assets\/)?release-sources\.renderer-worker\.[^/]+\.json$/u;

function canonical(entry) {
  return entry.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function receiptProblems(path, target, text) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (error) {
    return [`${path} is not valid JSON: ${error.message}`];
  }
  const problems = [];
  if (receipt?.schema !== RELEASE_SOURCES_SCHEMA)
    problems.push(`${path} has schema ${receipt?.schema}`);
  if (receipt?.policy !== RELEASE_POLICY) {
    problems.push(`${path} was built under the ${receipt?.policy} policy, not the release policy`);
  }
  if (receipt?.target !== target)
    problems.push(`${path} names target ${receipt?.target}, not ${target}`);
  const dependencies = receipt?.dependencySources;
  const validDependencies =
    Array.isArray(dependencies) &&
    dependencies.length > 0 &&
    dependencies.every(isDependencySourcePath);
  if (
    dependencies !== undefined &&
    (!Array.isArray(dependencies) || dependencies.some((source) => !isDependencySourcePath(source)))
  ) {
    problems.push(`${path} lists invalid dependency sources`);
  }
  if (
    !Array.isArray(receipt?.sources) ||
    (receipt.sources.length === 0 && !(target === 'renderer-worker' && validDependencies))
  ) {
    problems.push(`${path} lists no bundled sources`);
  }
  if (!Array.isArray(receipt?.violations) || receipt.violations.length > 0) {
    problems.push(`${path} records release boundary violations`);
  }
  for (const source of Array.isArray(receipt?.sources) ? receipt.sources : []) {
    const reason = releaseSourceViolation(source) ?? neverImportableViolation(source);
    if (reason) problems.push(`${path} lists ${source}: ${reason}`);
  }
  return problems;
}

function releaseSourceReceiptProblems(archiveEntries, readEntry) {
  const entries = new Map(archiveEntries.map((entry) => [canonical(entry), entry]));
  const problems = [];
  for (const [target, path] of REQUIRED_RECEIPTS) {
    if (!entries.has(path)) {
      problems.push(`${path} is missing; the release bundle boundary did not run for ${target}`);
      continue;
    }
    problems.push(...receiptProblems(path, target, readEntry(entries.get(path))));
  }
  for (const [path, entry] of entries) {
    if (WORKER_RECEIPT.test(path)) {
      problems.push(...receiptProblems(path, 'renderer-worker', readEntry(entry)));
    }
  }
  return problems;
}

module.exports = { REQUIRED_RECEIPTS, releaseSourceReceiptProblems };
