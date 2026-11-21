import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script =
  process.env.DNAFORGE_QUALIFICATION_SCRIPT ??
  fileURLToPath(new URL('./qualification.mjs', import.meta.url));
const journeys = ['workspace', 'track', 'genome', 'canvas', 'chat', 'palettes'];

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dnaforge-qualification-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Qualification fixture',
    GIT_AUTHOR_EMAIL: 'qualification@example.invalid',
    GIT_COMMITTER_NAME: 'Qualification fixture',
    GIT_COMMITTER_EMAIL: 'qualification@example.invalid',
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  writeFileSync(path.join(root, 'document.txt'), 'before\n');
  git('add', 'document.txt');
  const baseTree = git('write-tree');
  const baseSha = git('commit-tree', baseTree, '-m', 'Baseline fixture');
  writeFileSync(path.join(root, 'document.txt'), 'after\n');
  git('add', 'document.txt');
  const sourceTree = git('write-tree');
  const sourceSha = git('commit-tree', sourceTree, '-p', baseSha, '-m', 'Candidate fixture');
  git('update-ref', 'HEAD', sourceSha);
  const manifest = {
    version: 1,
    sourceSha,
    sourceTree,
    baseSha,
    controlSha: '3'.repeat(40),
    workflowSha: '7'.repeat(40),
    runId: '123456',
    attempt: 2,
    desktopShards: [1, 2, 3, 4, 5, 6, 7, 8],
    coverage: { nativeRequired: true, journeys: [...journeys] },
  };
  const manifestFile = path.join(root, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  return { root, manifest, manifestFile, baseTree };
}

function rawReceipt(f, command) {
  return {
    version: 1,
    kind: 'native',
    journey: 'workspace',
    sourceSha: command === 'bind-baseline' ? f.manifest.baseSha : f.manifest.sourceSha,
    sourceTree: command === 'bind-baseline' ? f.baseTree : f.manifest.sourceTree,
    controlSha: f.manifest.controlSha,
    workflowSha: f.manifest.workflowSha,
    runId: f.manifest.runId,
    runAttempt: String(f.manifest.attempt),
    status: 'passed',
  };
}

function invokeBinding(f, command, receipt) {
  const input = path.join(f.root, 'raw-receipt.json');
  const output = path.join(f.root, 'bound-receipt.json');
  const original = JSON.stringify(receipt);
  writeFileSync(input, original);
  const result = spawnSync(
    process.execPath,
    [
      script,
      command,
      '--root',
      f.root,
      '--manifest',
      f.manifestFile,
      '--receipt',
      input,
      '--out',
      output,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(readFileSync(input, 'utf8'), original, 'Binding rewrote original evidence');
  return { ...result, output };
}

for (const command of ['bind-native', 'bind-baseline']) {
  test(`${command} preserves matching source and producer identities`, (t) => {
    const f = fixture(t);
    const receipt = rawReceipt(f, command);
    const result = invokeBinding(f, command, receipt);
    assert.equal(result.status, 0, result.stderr);
    const bound = JSON.parse(readFileSync(result.output, 'utf8'));
    for (const key of ['sourceSha', 'sourceTree', 'controlSha', 'runId'])
      assert.equal(bound[key], receipt[key]);
    assert.equal(bound.attempt, f.manifest.attempt);
    if (command === 'bind-baseline') {
      assert.equal(bound.kind, 'baseline-native');
      assert.equal(bound.candidateSha, f.manifest.sourceSha);
    }
  });

  const mismatches = [
    [
      'control revision',
      (receipt) => {
        receipt.controlSha = '4'.repeat(40);
      },
    ],
    [
      'workflow revision',
      (receipt) => {
        receipt.workflowSha = '4'.repeat(40);
      },
    ],
    [
      'workflow run',
      (receipt) => {
        receipt.runId = '123457';
      },
    ],
    [
      'workflow attempt',
      (receipt) => {
        receipt.runAttempt = '1';
      },
    ],
    [
      'source commit',
      (receipt) => {
        receipt.sourceSha = '5'.repeat(40);
      },
    ],
    [
      'source tree',
      (receipt) => {
        receipt.sourceTree = '6'.repeat(40);
      },
    ],
    [
      'missing control revision',
      (receipt) => {
        delete receipt.controlSha;
      },
    ],
    [
      'missing workflow revision',
      (receipt) => {
        delete receipt.workflowSha;
      },
    ],
    [
      'missing workflow run',
      (receipt) => {
        delete receipt.runId;
      },
    ],
    [
      'missing workflow attempt',
      (receipt) => {
        delete receipt.runAttempt;
      },
    ],
  ];
  for (const [name, mutate] of mismatches) {
    test(`${command} refuses ${name} without emitting a relabeled receipt`, (t) => {
      const f = fixture(t);
      const receipt = rawReceipt(f, command);
      mutate(receipt);
      const result = invokeBinding(f, command, receipt);
      assert.notEqual(
        result.status,
        0,
        `${command} accepted mismatched evidence: ${result.stdout}`
      );
      assert.equal(existsSync(result.output), false, 'Rejected evidence produced a bound receipt');
    });
  }
}

test('bind-baseline retains a settled failing baseline without calling it a passing journey', (t) => {
  const f = fixture(t);
  const receipt = {
    ...rawReceipt(f, 'bind-baseline'),
    status: 'failed',
    failure: { stage: 'setup', message: 'fixture could not start' },
  };
  const result = invokeBinding(f, 'bind-baseline', receipt);
  assert.equal(result.status, 0, result.stderr);
  const bound = JSON.parse(readFileSync(result.output, 'utf8'));
  assert.equal(bound.status, 'failed');
  assert.deepEqual(bound.failure, receipt.failure);
});

test('bind-native refuses a failing candidate journey', (t) => {
  const f = fixture(t);
  const result = invokeBinding(f, 'bind-native', {
    ...rawReceipt(f, 'bind-native'),
    status: 'failed',
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(result.output), false);
});

function assessNative(f, mutate) {
  const reports = [];
  for (const journey of journeys) {
    reports.push({ ...f.manifest, kind: 'native', journey, status: 'passed' });
    reports.push({
      ...f.manifest,
      kind: 'baseline-native',
      journey,
      sourceSha: f.manifest.baseSha,
      sourceTree: f.baseTree,
      candidateSha: f.manifest.sourceSha,
      status: 'passed',
    });
  }
  mutate(reports);
  const directory = path.join(f.root, 'reports');
  mkdirSync(directory);
  for (let index = 0; index < reports.length; index += 1)
    writeFileSync(path.join(directory, `${index}.json`), JSON.stringify(reports[index]));
  const output = path.join(f.root, 'native-summary.json');
  const result = spawnSync(
    process.execPath,
    [
      script,
      'assess',
      '--kind',
      'native',
      '--root',
      f.root,
      '--manifest',
      f.manifestFile,
      '--reports',
      directory,
      '--out',
      output,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QUALIFICATION_NEEDS: JSON.stringify({
          plan: { result: 'success' },
          'native-journeys': { result: 'success' },
        }),
      },
    }
  );
  return { ...result, output };
}

test('native candidate qualification retains failed baseline evidence without requiring the old defect to pass', (t) => {
  const f = fixture(t);
  const result = assessNative(f, (reports) => {
    reports.find((report) => report.kind === 'baseline-native').status = 'failed';
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(result.output, 'utf8'));
  assert.equal(summary.status, 'passed');
  assert.equal(summary.native.baseline.filter((report) => report.status === 'failed').length, 1);
  assert.equal(summary.native.comparison, 'baseline-failure-needs-classification');
});

test('native candidate qualification rejects an unsettled baseline', (t) => {
  const f = fixture(t);
  const result = assessNative(f, (reports) => {
    reports.find((report) => report.kind === 'baseline-native').status = 'pending';
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(result.output), false);
});

test('a passing baseline never substitutes for a failed candidate journey', (t) => {
  const f = fixture(t);
  const result = assessNative(f, (reports) => {
    reports.find((report) => report.kind === 'native').status = 'failed';
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(result.output), false);
});
