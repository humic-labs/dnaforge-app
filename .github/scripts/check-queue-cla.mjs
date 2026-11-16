import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readCommits, unsignedCommits } from './check-cla-sign-off.mjs';

export function queueContributionCommits(base, head, { cwd } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('merge-base', '--is-ancestor', base, head);
  const synthetic = git('rev-list', '--first-parent', `${base}..${head}`)
    .split('\n')
    .filter(Boolean);
  assert.ok(synthetic.length > 0, 'Empty queue candidate');
  const commits = new Map();
  let previous = base;
  for (const sha of synthetic.reverse()) {
    const parents = git('show', '-s', '--format=%P', sha).split(' ');
    assert.equal(parents[0], previous, 'Queue candidate has an unexpected first parent');
    assert.ok(parents.length >= 2, 'Queue candidate is not a synthesized merge');
    for (const parent of parents.slice(1)) {
      for (const commit of readCommits(base, parent, { cwd })) commits.set(commit.sha, commit);
    }
    previous = sha;
  }
  assert.ok(commits.size > 0, 'Queue has no contribution commits');
  return [...commits.values()];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, head] = process.argv.slice(2);
  const missing = unsignedCommits(queueContributionCommits(base, head));
  assert.equal(
    missing.length,
    0,
    `Unsigned contribution commits: ${missing.map(({ sha }) => sha).join(', ')}`
  );
  console.log('Every queued contribution commit agrees to the CLA.');
}
