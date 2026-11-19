import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const controlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const git = (root, ...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

function sameIdentity(manifest, report) {
  for (const key of ['sourceSha', 'sourceTree', 'controlSha'])
    assert.match(manifest[key], /^[a-f0-9]{40}$/u, `Invalid ${key}`);
  assert.match(manifest.runId, /^\d+$/u, 'Invalid run identity');
  assert.ok(Number.isInteger(manifest.attempt) && manifest.attempt > 0, 'Invalid run attempt');
  for (const key of ['sourceSha', 'sourceTree', 'controlSha', 'runId', 'attempt']) {
    assert.notEqual(manifest[key], undefined, `Missing manifest ${key}`);
    assert.equal(report[key], manifest[key], `Report ${key} differs from candidate`);
  }
}

function unique(values, label) {
  assert.ok(Array.isArray(values) && values.length > 0, `${label} is empty`);
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
  return new Set(values);
}

export function inspectDesktopReports({ manifest, reports, expectedFiles, skipBudget = {} }) {
  const expectedShards = unique(manifest.desktopShards, 'Expected shards');
  const inventory = unique(expectedFiles, 'Desktop inventory');
  assert.equal(reports.length, expectedShards.size, 'Missing desktop shard reports');
  const seenShards = new Set();
  const seenFiles = new Set();
  let passed = 0;
  let skipped = 0;
  const pending = {};
  for (const report of reports) {
    sameIdentity(manifest, report);
    assert.equal(report.kind, 'desktop');
    assert.ok(expectedShards.has(report.shard), 'Unexpected shard');
    assert.ok(!seenShards.has(report.shard), 'Duplicate shard');
    seenShards.add(report.shard);
    assert.equal(report.shards, expectedShards.size, 'Shard count changed');
    const shardFiles = unique(report.expectedFiles, 'Shard inventory');
    const result = report.result;
    assert.equal(result.success, true, 'Desktop tests did not pass');
    assert.equal(result.numFailedTests, 0, 'Failed tests');
    assert.equal(result.numFailedTestSuites, 0, 'Failed suites');
    assert.equal(result.numRuntimeErrorTestSuites ?? 0, 0, 'Runtime errors');
    assert.ok(result.numPassedTests > 0, 'Empty passed test selection');
    assert.ok(Array.isArray(result.testResults), 'Missing test results');
    const observedFiles = new Set();
    let observedPassed = 0;
    let observedPending = 0;
    for (const file of result.testResults) {
      assert.ok(shardFiles.has(file.name), `Undeclared test file ${file.name}`);
      assert.ok(inventory.has(file.name), `Unexpected test file ${file.name}`);
      assert.ok(
        !observedFiles.has(file.name) && !seenFiles.has(file.name),
        `Duplicate test file ${file.name}`
      );
      observedFiles.add(file.name);
      seenFiles.add(file.name);
      assert.notEqual(file.status, 'failed', `Failed test file ${file.name}`);
      assert.ok(
        Array.isArray(file.assertionResults) && file.assertionResults.length > 0,
        `Empty test file ${file.name}`
      );
      let filePending = 0;
      for (const test of file.assertionResults) {
        assert.ok(
          ['passed', 'pending', 'skipped', 'todo', 'disabled'].includes(test.status),
          `Unsettled test ${test.fullName}`
        );
        if (test.status === 'passed') observedPassed += 1;
        else filePending += 1;
      }
      assert.ok(
        filePending <= (skipBudget[file.name] ?? 0),
        `Unexpected skipped tests in ${file.name}`
      );
      if (filePending) pending[file.name] = filePending;
      observedPending += filePending;
    }
    assert.deepEqual(
      [...observedFiles].sort(),
      [...shardFiles].sort(),
      'Shard omitted discovered files'
    );
    assert.equal(observedPassed, result.numPassedTests, 'Passed count differs from assertions');
    assert.equal(
      observedPending,
      (result.numPendingTests ?? 0) + (result.numTodoTests ?? 0),
      'Skipped count differs from assertions'
    );
    assert.equal(
      result.numTotalTests,
      observedPassed + observedPending,
      'Total count differs from assertions'
    );
    passed += observedPassed;
    skipped += observedPending;
  }
  assert.deepEqual([...seenFiles].sort(), [...inventory].sort(), 'Shards omitted discovered files');
  return { files: seenFiles.size, passed, skipped, pending, shards: seenShards.size };
}

export function inspectNativeReports({ manifest, reports, journeys }) {
  const expected = unique(journeys, 'Native journeys');
  assert.equal(reports.length, expected.size, 'Missing native reports');
  const seen = new Set();
  for (const report of reports) {
    sameIdentity(manifest, report);
    assert.equal(report.kind, 'native');
    assert.ok(expected.has(report.journey), 'Unexpected native journey');
    assert.ok(!seen.has(report.journey), 'Duplicate native journey');
    assert.equal(report.status, 'passed', `Native journey failed: ${report.journey}`);
    seen.add(report.journey);
  }
  return { journeys: [...seen].sort() };
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(full) : entry.name.endsWith('.json') ? [full] : [];
  });
}

function run(command, args, root, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.error?.message ?? result.signal ?? result.status}`
  );
}

function normalizeFile(root, filename) {
  const relative = path
    .relative(path.join(root, 'apps/desktop'), path.resolve(filename))
    .replaceAll('\\', '/');
  assert.ok(
    relative.startsWith('src/') || relative.startsWith('../../e2e/helpers/'),
    `Unexpected inventory path ${filename}`
  );
  return relative;
}

async function discover(root, shard) {
  const desktop = path.join(root, 'apps/desktop');
  const require = createRequire(path.join(desktop, 'package.json'));
  const environment = {
    TEST: 'true',
    VITEST: 'true',
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    DNAFORGE_FULL_ASSEMBLY_CATALOG_TESTS: '1',
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  const cwd = process.cwd();
  let ctx;
  try {
    Object.assign(process.env, environment);
    process.chdir(desktop);
    const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href);
    ctx = await createVitest('test', { root: desktop, run: true, watch: false, shard });
    let specifications = await ctx.globTestSpecifications();
    if (shard) {
      const groups = new Map();
      for (const spec of specifications) {
        const key = JSON.stringify([spec.project.config.sequence.groupOrder ?? 0, spec.pool]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(spec);
      }
      const sequencer = new ctx.config.sequence.sequencer(ctx);
      specifications = (
        await Promise.all([...groups.values()].map((files) => sequencer.shard(files)))
      ).flat();
    }
    const files = specifications.map((spec) => normalizeFile(root, spec.moduleId));
    unique(files, 'Discovered files');
    return files.sort();
  } finally {
    try {
      await ctx?.close();
    } finally {
      process.chdir(cwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

function options(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(args[index].startsWith('--') && args[index + 1], `Invalid argument ${args[index]}`);
    values[args[index].slice(2)] = args[index + 1];
  }
  return values;
}

async function main(args) {
  const [command, ...rest] = args;
  const opt = options(rest);
  assert.ok(opt.out, '--out is required');
  const root = path.resolve(opt.root ?? process.cwd());
  if (command === 'plan') {
    const { policy, selectRequiredWork } = await import('./merge-policy.mjs');
    const { ciBranches, ciLane } = await import('./preflight.mjs');
    const event = read(process.env.GITHUB_EVENT_PATH);
    const bootstrap =
      process.env.CI_BOOTSTRAP_MAIN === 'true' &&
      ((process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main') ||
        (process.env.GITHUB_EVENT_NAME === 'pull_request' &&
          event.pull_request?.base?.ref === 'main'));
    const lane = bootstrap
      ? 'qualification'
      : ciLane(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_REF, ciBranches(policy));
    assert.equal(lane, 'qualification', 'Broad CI is not the development admission lane');
    const sourceSha = git(root, 'rev-parse', 'HEAD');
    assert.equal(sourceSha, process.env.GITHUB_SHA, 'Checkout differs from event candidate');
    const baseSha = opt.base || git(root, 'rev-parse', 'HEAD^1');
    assert.match(baseSha, /^[a-f0-9]{40}$/u);
    const changed = git(root, 'diff', '--name-only', '--no-renames', baseSha, sourceSha)
      .split('\n')
      .filter(Boolean);
    const manifest = {
      version: 1,
      sourceSha,
      sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
      baseSha,
      controlSha: git(controlRoot, 'rev-parse', 'HEAD'),
      controlRef: bootstrap
        ? process.env.GITHUB_WORKFLOW_REF
        : `${policy.repository.name}/${policy.branches[policy.release.sourceBranch].workflow}@${policy.authority.ref}`,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      lane,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      desktopShards: Array.from({ length: policy.desktop.shards }, (_, i) => i + 1),
      coverage: selectRequiredWork(changed),
      changed,
    };
    assert.match(manifest.controlSha, /^[a-f0-9]{40}$/u);
    assert.match(manifest.workflowSha, /^[a-f0-9]{40}$/u);
    if (bootstrap)
      assert.equal(
        manifest.controlSha,
        manifest.workflowSha,
        'Bootstrap control differs from the workflow revision'
      );
    assert.equal(
      git(controlRoot, 'rev-parse', 'HEAD'),
      manifest.controlSha,
      'Control checkout differs from the workflow revision'
    );
    assert.ok(
      typeof manifest.controlRef === 'string' && manifest.controlRef.length > 0,
      'Missing workflow reference'
    );
    assert.match(manifest.runId, /^\d+$/u);
    assert.ok(manifest.attempt > 0);
    write(opt.out, manifest);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `shards=${JSON.stringify(manifest.desktopShards)}\nnative=${manifest.coverage.nativeRequired}\njourneys=${JSON.stringify(policy.native.journeys)}\nbase=${baseSha}\ncontrol=${manifest.controlSha}\n`
      );
    return;
  }
  const manifest = read(opt.manifest);
  if (['inventory', 'desktop', 'bind-native'].includes(command)) {
    assert.equal(git(root, 'rev-parse', 'HEAD'), manifest.sourceSha, 'Source changed');
    assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), manifest.sourceTree, 'Tree changed');
  }
  if (command === 'inventory')
    return write(opt.out, { ...manifest, kind: 'inventory', files: await discover(root) });
  if (command === 'desktop') {
    const shard = Number(opt.shard);
    assert.ok(manifest.desktopShards.includes(shard), 'Unknown shard');
    const shards = manifest.desktopShards.length;
    const expectedFiles = await discover(root, `${shard}/${shards}`);
    const resultFile = path.resolve(opt.out + '.vitest.json');
    mkdirSync(path.dirname(resultFile), { recursive: true });
    let failure;
    try {
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          `--shard=${shard}/${shards}`,
          '--reporter=default',
          '--reporter=json',
          `--outputFile.json=${resultFile}`,
        ],
        path.join(root, 'apps/desktop'),
        {
          DNAFORGE_FULL_ASSEMBLY_CATALOG_TESTS: '1',
          DNAFORGE_REQUIRE_MAIN_BUNDLE: '1',
          NODE_OPTIONS: '--max-old-space-size=4096',
        }
      );
    } catch (error) {
      failure = error;
    }
    const result = read(resultFile);
    result.testResults = result.testResults.map((file) => ({
      ...file,
      name: normalizeFile(root, file.name),
    }));
    write(opt.out, { ...manifest, kind: 'desktop', shard, shards, expectedFiles, result });
    if (failure) throw failure;
    return;
  }
  if (['bind-native', 'bind-baseline'].includes(command)) {
    const receipt = read(opt.receipt);
    assert.equal(receipt.controlSha, manifest.controlSha, 'Native control revision mismatch');
    assert.equal(
      receipt.workflowSha,
      manifest.workflowSha ?? manifest.controlSha,
      'Native workflow revision mismatch'
    );
    assert.equal(receipt.runId, manifest.runId, 'Native run mismatch');
    assert.equal(Number(receipt.runAttempt), manifest.attempt, 'Native run attempt mismatch');
  }
  if (command === 'bind-native') {
    const receipt = read(opt.receipt);
    assert.equal(receipt.sourceSha, manifest.sourceSha);
    assert.equal(receipt.sourceTree, manifest.sourceTree);
    assert.equal(receipt.status, 'passed');
    return write(opt.out, {
      ...receipt,
      controlSha: manifest.controlSha,
      runId: manifest.runId,
      attempt: manifest.attempt,
    });
  }
  if (command === 'bind-baseline') {
    const receipt = read(opt.receipt);
    assert.equal(receipt.sourceSha, manifest.baseSha, 'Baseline is not the candidate base');
    assert.equal(
      receipt.sourceTree,
      git(root, 'rev-parse', `${manifest.baseSha}^{tree}`),
      'Baseline tree differs from its commit'
    );
    assert.ok(['passed', 'failed'].includes(receipt.status), 'Baseline did not settle');
    return write(opt.out, {
      ...receipt,
      kind: 'baseline-native',
      candidateSha: manifest.sourceSha,
      controlSha: manifest.controlSha,
      runId: manifest.runId,
      attempt: manifest.attempt,
    });
  }
  if (command === 'assess') {
    const needs = JSON.parse(process.env.QUALIFICATION_NEEDS ?? '{}');
    const expectedNeeds =
      opt.kind === 'desktop'
        ? ['plan', 'desktop-build', 'desktop-discovery', 'desktop-tests', 'package-tests']
        : opt.kind === 'native'
          ? ['plan', 'native-journeys']
          : ['plan', 'desktop', 'sidecar', 'run-from-source', 'native', 'controls'];
    assert.deepEqual(
      Object.keys(needs).sort(),
      expectedNeeds.sort(),
      'Unexpected dependency roster'
    );
    for (const [name, value] of Object.entries(needs)) {
      const allowed =
        opt.kind === 'native' && name === 'native-journeys' && !manifest.coverage.nativeRequired
          ? 'skipped'
          : 'success';
      assert.equal(value.result, allowed, `${name} did not conclude ${allowed}`);
    }
    const reports = jsonFiles(opt.reports).map(read);
    if (opt.kind === 'desktop') {
      const inventories = reports.filter((report) => report.kind === 'inventory');
      assert.equal(inventories.length, 1, 'Missing or duplicate desktop inventory');
      sameIdentity(manifest, inventories[0]);
      const desktop = inspectDesktopReports({
        manifest,
        reports: reports.filter((report) => report.kind === 'desktop'),
        expectedFiles: inventories[0].files,
        skipBudget: read(path.join(controlRoot, '.ci/desktop-skips.json')).files,
      });
      return write(opt.out, { ...manifest, kind: 'desktop-summary', status: 'passed', desktop });
    }
    if (opt.kind === 'native') {
      const nativeReports = reports.filter((report) => report.kind === 'native');
      const native = manifest.coverage.nativeRequired
        ? inspectNativeReports({
            manifest,
            reports: nativeReports,
            journeys: manifest.coverage.journeys,
          })
        : { journeys: [], reason: manifest.coverage.reason };
      const baseline = reports.filter((report) => report.kind === 'baseline-native');
      if (manifest.coverage.nativeRequired) {
        assert.deepEqual(
          baseline.map((report) => report.journey).sort(),
          [...manifest.coverage.journeys].sort(),
          'Missing or duplicate baseline journeys'
        );
        for (const report of baseline) {
          assert.equal(report.sourceSha, manifest.baseSha);
          assert.equal(report.candidateSha, manifest.sourceSha);
          for (const key of ['controlSha', 'runId', 'attempt'])
            assert.equal(report[key], manifest[key], `Baseline ${key} mismatch`);
          assert.ok(['passed', 'failed'].includes(report.status), 'Baseline did not settle');
        }
        native.baseline = baseline.map(({ journey, sourceSha, sourceTree, status }) => ({
          journey,
          sourceSha,
          sourceTree,
          status,
        }));
        native.comparison = baseline.every(({ status }) => status === 'passed')
          ? 'both-pass'
          : 'baseline-failure-needs-classification';
      }
      if (!manifest.coverage.nativeRequired)
        assert.equal(nativeReports.length, 0, 'Unexpected native results for documented exclusion');
      return write(opt.out, { ...manifest, kind: 'native-summary', status: 'passed', native });
    }
    assert.equal(opt.kind, 'all');
    const summary = {};
    for (const kind of ['desktop', 'native']) {
      const matches = reports.filter((report) => report.kind === `${kind}-summary`);
      assert.equal(matches.length, 1, `Missing ${kind} summary`);
      sameIdentity(manifest, matches[0]);
      assert.equal(matches[0].status, 'passed');
      summary[kind] = matches[0][kind];
    }
    return write(opt.out, {
      ...manifest,
      kind: 'qualification',
      status: 'passed',
      ...summary,
      needs,
    });
  }
  throw new Error(`Unknown command ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
