import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { queueContributionCommits } from './check-queue-cla.mjs';
import { unsignedCommits } from './check-cla-sign-off.mjs';

test('queue sign-off checks contribution merges but excludes only synthetic queue commits', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'queue-cla-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture Contributor');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(cwd, 'empty-hooks'));
    git('commit', '--allow-empty', '-s', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'contribution');
    writeFileSync(path.join(cwd, 'file'), 'content');
    git('add', 'file');
    git('commit', '-s', '-m', 'signed change');
    const signed = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'unsigned change');
    const unsigned = git('rev-parse', 'HEAD');
    git('switch', 'main');
    git('merge', '--no-ff', 'contribution', '-m', 'synthetic queue merge');
    const head = git('rev-parse', 'HEAD');
    const commits = queueContributionCommits(base, head, { cwd });
    assert.deepEqual(new Set(commits.map(({ sha }) => sha)), new Set([signed, unsigned]));
    assert.deepEqual(
      unsignedCommits(commits).map(({ sha }) => sha),
      [unsigned]
    );
    assert.throws(() => queueContributionCommits(base, base, { cwd }));
    assert.throws(() => queueContributionCommits(base, signed, { cwd }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
