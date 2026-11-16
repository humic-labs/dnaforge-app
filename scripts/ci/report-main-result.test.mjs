import assert from 'node:assert/strict';
import test from 'node:test';
import { failureIssue } from './report-main-result.mjs';

test('a failure report binds the exact run and keeps ownership without inventing causation', () => {
  const value = {
    repository: 'humic-labs/dnaforge-app',
    sha: 'a'.repeat(40),
    runUrl: 'https://github.com/humic-labs/dnaforge-app/actions/runs/123',
    pullRequests: [{ number: 1, title: 'Contribution' }],
    jobs: [{ name: 'Native workflow acceptance', conclusion: 'failure' }],
  };
  const issue = failureIssue(value);
  assert.ok(issue.body.includes(value.sha));
  assert.ok(issue.body.includes(value.runUrl));
  assert.ok(issue.body.includes('Contribution #1'));
  assert.throws(() =>
    failureIssue({
      ...value,
      jobs: [{ name: 'Native workflow acceptance', conclusion: 'success' }],
    })
  );
  assert.throws(() => failureIssue({ ...value, runUrl: 'https://example.invalid' }));
});
