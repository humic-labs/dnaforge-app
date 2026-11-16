import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectDesktopReports } from '../qualification.mjs';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const script = fileURLToPath(new URL('../qualification.mjs', import.meta.url));

test('actual Vitest shards declare exactly their executed files and together qualify the complete inventory', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dnaforge-qualification-shards-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'apps/desktop');
  mkdirSync(path.join(desktop, 'src/nested'), { recursive: true });
  symlinkSync(
    path.join(repository, 'apps/desktop/node_modules'),
    path.join(desktop, 'node_modules'),
    'dir'
  );
  const files = [
    'src/alpha.test.mjs',
    'src/alpha.test.mjs.more.test.mjs',
    'src/beta.test.mjs',
    'src/nested/gamma.test.mjs',
  ];
  for (const file of files)
    writeFileSync(
      path.join(desktop, file),
      `test(${JSON.stringify(file)}, () => expect(2 + 2).toBe(4));\n`
    );
  writeFileSync(
    path.join(desktop, 'package.json'),
    JSON.stringify({ name: 'qualification-shard-fixture', private: true, type: 'module' })
  );
  writeFileSync(
    path.join(desktop, 'vitest.config.mjs'),
    `export default ${JSON.stringify({ test: { globals: true, environment: 'node', include: ['src/**/*.test.mjs'], minWorkers: 1, maxWorkers: 1, fileParallelism: false, pool: 'forks' } })};\n`
  );
  const env = {
    ...process.env,
    PATH: `${path.join(repository, 'apps/desktop/node_modules/.bin')}${path.delimiter}${process.env.PATH}`,
    GIT_AUTHOR_NAME: 'Qualification fixture',
    GIT_AUTHOR_EMAIL: 'qualification@example.invalid',
    GIT_COMMITTER_NAME: 'Qualification fixture',
    GIT_COMMITTER_EMAIL: 'qualification@example.invalid',
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', 'apps/desktop');
  const sourceTree = git('write-tree');
  const sourceSha = git('commit-tree', sourceTree, '-m', 'Independent tiny shard fixture');
  git('update-ref', 'HEAD', sourceSha);
  const manifest = {
    version: 1,
    sourceSha,
    sourceTree,
    controlSha: '3'.repeat(40),
    workflowSha: '7'.repeat(40),
    runId: '123456',
    attempt: 1,
    desktopShards: [1, 2],
  };
  const manifestFile = path.join(root, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const invoke = (command, extra = []) => {
    const output = path.join(root, `${command}-${extra.join('-') || 'all'}.json`);
    const run = spawnSync(
      process.execPath,
      [script, command, '--root', root, '--manifest', manifestFile, '--out', output, ...extra],
      { cwd: root, encoding: 'utf8', env, timeout: 20000 }
    );
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
    return JSON.parse(readFileSync(output, 'utf8'));
  };
  const inventory = invoke('inventory');
  assert.deepEqual(inventory.files, [...files].sort());
  const reports = [1, 2].map((shard) => invoke('desktop', ['--shard', String(shard)]));
  for (const report of reports) {
    assert.equal(report.result.success, true);
    assert.deepEqual(
      [...report.expectedFiles].sort(),
      report.result.testResults.map((file) => file.name).sort(),
      `Shard ${report.shard} declares files it did not execute`
    );
    assert.equal(report.expectedFiles.length, 2);
  }
  assert.equal(
    reports[0].expectedFiles.some((file) => reports[1].expectedFiles.includes(file)),
    false,
    'Shards overlap'
  );
  assert.deepEqual(reports.flatMap((report) => report.expectedFiles).sort(), inventory.files);
  const qualification = inspectDesktopReports({
    manifest,
    reports,
    expectedFiles: inventory.files,
  });
  assert.equal(qualification.files, 4);
  assert.equal(qualification.passed, 4);
  assert.equal(qualification.shards, 2);
});
