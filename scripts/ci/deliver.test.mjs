import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueQualifiedPullRequest, inspectPullRequest, parseArguments } from './deliver.mjs';
import { policy } from './merge-policy.mjs';
import { qualifiedFixture } from './delivery-fixture.mjs';

const head = '1'.repeat(40);
const route = `repos/${policy.repository.name}`;

function heldApi() {
  const calls = [];
  const pr = { number: 99, node_id: 'PR_99', state: 'open', draft: true, labels: [], head: { sha: head },
    base: { ref: 'main', sha: '2'.repeat(40), repo: { id: policy.repository.id } }, auto_merge: null };
  const api = (path, options = {}) => {
    calls.push({ path, ...options });
    assert.equal(options.method ?? 'GET', 'GET', 'inspection must not mutate GitHub');
    if (path === route) return { id: policy.repository.id, full_name: policy.repository.name };
    if (path === `${route}/pulls/99`) return structuredClone(pr);
    if (path === `${route}/branches/main`) return { commit: { sha: pr.base.sha } };
    if (path === `${route}/rules/branches/main`) return [];
    if (path.includes('/files?')) return [{ filename: 'README.md', previous_filename: 'apps/desktop/src/App.tsx' }];
    if (path.includes('/actions/runs?')) return { workflow_runs: [] };
    if (path.includes('/check-runs?')) return { check_runs: [] };
    throw new Error(`Unexpected request ${path}`);
  };
  return { api, calls, pr };
}

test('default preparation does not arm admission', () => {
  assert.equal(parseArguments(['--pr', '99']).command, 'inspect');
  assert.equal(parseArguments(['prepare', '--pr', '99']).command, 'prepare');
  assert.throws(() => parseArguments(['prepare', '--pr', '99', '--authorize-merge']), /only for/u);
});

test('inspection preserves a server draft and observes both sides of a rename', () => {
  const { api, calls, pr } = heldApi();
  const receipt = inspectPullRequest(99, { api });
  assert.equal(receipt.decision.state, 'rejected');
  assert(receipt.decision.reasons.includes('Pull request is held as a draft'));
  assert.deepEqual(receipt.observation.changedPaths, ['README.md', 'apps/desktop/src/App.tsx']);
  assert.equal(pr.draft, true);
  assert.equal(pr.auto_merge, null);
  assert.equal(calls.filter((call) => call.path === `${route}/pulls/99`).length, 2);
});

test('explicit enqueue still refuses a held unqualified candidate without a write', () => {
  const { api, calls } = heldApi();
  const receipt = enqueueQualifiedPullRequest(99, { api, expectedHead: head, authorizeMerge: true });
  assert.equal(receipt.decision.state, 'rejected');
  assert(calls.every((call) => !call.method || call.method === 'GET'));
});

test('enqueue without authority or exact head performs no provider operation', () => {
  const api = () => { throw new Error('provider must not be called'); };
  assert.throws(() => enqueueQualifiedPullRequest(99, { api, expectedHead: head }), /explicit merge authority/u);
  assert.throws(() => enqueueQualifiedPullRequest(99, { api, authorizeMerge: true }), /expected-head/u);
});

test('argument parsing rejects malformed and duplicate input', () => {
  for (const args of [[], ['inspect', '--pr', 'NaN'], ['prepare', '--pr', '1', '--pr', '2'], ['inspect', '--wat'], ['delete', '--pr', '1']]) {
    assert.throws(() => parseArguments(args));
  }
});

function qualifiedApi() {
  const { candidate, observation } = qualifiedFixture();
  const writes = [];
  const artifactRuns = [];
  const api = (path, options = {}) => {
    if (options.method === 'POST') {
      writes.push({ path, body: options.body });
      return { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'QUEUE_99', state: 'QUEUED', position: 1 } } } };
    }
    if (path === route) return observation.repository;
    if (path === `${route}/pulls/99`) return structuredClone(candidate);
    if (path === `${route}/branches/main`) return { commit: { sha: candidate.base.sha } };
    if (path === `${route}/rules/branches/main`) return observation.rules;
    if (path.includes('/files?')) return observation.changedPaths.map((filename) => ({ filename }));
    if (path.includes('/actions/runs?')) return { workflow_runs: observation.runs };
    if (path.includes('/check-runs?')) return { check_runs: observation.checks };
    if (path.includes('/attempts/2/jobs?')) return { jobs: observation.jobs[path.includes('/runs/10/') ? 10 : 11] };
    if (path.includes('/commits/')) return observation.sourceCommit;
    if (path.includes('/compare/')) return { status: 'identical' };
    throw new Error(`Unexpected request ${path}`);
  };
  return { api, writes, observation, artifactRuns, readArtifact: (run) => {
    artifactRuns.push(run.id);
    return { value: observation.qualification, artifact: { id: 99 } };
  } };
}

test('inspection downloads only the injected CI result when ordinary CI is newer', () => {
  const harness = qualifiedApi();
  harness.observation.runs.push({ ...harness.observation.runs[0], id: 100,
    workflow_url: `https://api.github.com/repos/${policy.repository.name}/actions/workflows/10` });
  const receipt = inspectPullRequest(99, harness);
  assert.equal(receipt.decision.state, 'qualified');
  assert.deepEqual(harness.artifactRuns, [10]);
});

test('ordinary CI success cannot download evidence or enqueue a candidate', () => {
  const harness = qualifiedApi();
  harness.observation.runs[0].workflow_url = `https://api.github.com/repos/${policy.repository.name}/actions/workflows/10`;
  const receipt = enqueueQualifiedPullRequest(99, {
    ...harness, expectedHead: head, authorizeMerge: true, localHead: head, localStatus: '',
  });
  assert.equal(receipt.decision.state, 'pending');
  assert.deepEqual(harness.artifactRuns, []);
  assert.deepEqual(harness.writes, []);
});

test('qualified explicit admission sends one exact-head queue mutation, never auto-merge', () => {
  const harness = qualifiedApi();
  const receipt = enqueueQualifiedPullRequest(99, {
    ...harness, expectedHead: head, authorizeMerge: true, localHead: head, localStatus: '',
  });
  assert.equal(receipt.admission.state, 'enqueued');
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].path, 'graphql');
  assert.deepEqual(harness.writes[0].body.variables, { id: 'PR_example', head });
  assert.match(harness.writes[0].body.query, /enqueuePullRequest/u);
  assert.doesNotMatch(harness.writes[0].body.query, /autoMerge|jump|mergePullRequest/u);
});

test('qualified remote result cannot admit a dirty or different local checkout', () => {
  for (const local of [{ localHead: 'f'.repeat(40), localStatus: '' }, { localHead: head, localStatus: ' M file' }]) {
    const harness = qualifiedApi();
    assert.throws(() => enqueueQualifiedPullRequest(99, { ...harness, ...local, expectedHead: head, authorizeMerge: true }), /clean local checkout/u);
    assert.equal(harness.writes.length, 0);
  }
});
