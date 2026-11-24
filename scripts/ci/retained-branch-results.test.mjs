import assert from 'node:assert/strict';
import test from 'node:test';
import { failureIssue, retainedPushBranch } from './report-main-result.mjs';

const sha = 'a'.repeat(40);
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_SHA: sha, GITHUB_RUN_ATTEMPT: '2' };
const run = { head_branch: 'dev', head_sha: sha, event: 'push', run_attempt: 2 };

test('retained results bind each integration branch to the actual push and attempt', () => {
  for (const branch of ['dev', 'staging', 'prod', 'main']) {
    assert.equal(retainedPushBranch({ ...env, GITHUB_REF: `refs/heads/${branch}` }, { ...run, head_branch: branch }), branch);
    const issue = failureIssue({ repository: 'humic-labs/dnaforge-app', branch, sha,
      runUrl: 'https://github.com/humic-labs/dnaforge-app/actions/runs/123', pullRequests: [],
      jobs: [{ name: 'Promotion qualification', conclusion: 'failure' }] });
    assert.ok(issue.title.startsWith(`${branch} qualification failed`));
    assert.ok(issue.body.includes(`on ${branch} commit`));
  }
});

test('another branch, source, attempt or event cannot label retained evidence', () => {
  for (const changed of [
    { head_branch: 'prod' }, { head_sha: 'b'.repeat(40) },
    { event: 'pull_request' }, { run_attempt: 1 },
  ]) assert.throws(() => retainedPushBranch(env, { ...run, ...changed }));
  assert.throws(() => retainedPushBranch({ ...env, GITHUB_REF: 'refs/tags/dev' }, run));
  assert.throws(() => retainedPushBranch({ ...env, GITHUB_REF: 'refs/heads/unknown' }, { ...run, head_branch: 'unknown' }));
});
