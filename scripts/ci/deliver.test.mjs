import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverPullRequest, enqueueQualifiedPullRequest, inspectPullRequest, parseArguments, promoteQualifiedPullRequest } from './deliver.mjs';
import { branchPolicy, policy } from './merge-policy.mjs';
import { qualifiedFixture } from './delivery-fixture.mjs';

const head = '1'.repeat(40);
const merge = '5'.repeat(40);
const route = `repos/${policy.repository.name}`;
const local = { expectedHead: head, localHead: head, localStatus: '' };

function apiFixture(target = 'dev') {
  const { candidate, observation } = qualifiedFixture(target);
  const calls = [], writes = [], artifactRuns = [];
  let queued = false, merged = false;
  const harness = { candidate, observation, calls, writes, artifactRuns, mergeAfterEnqueue: true };
  const api = (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === 'graphql') {
      const query = options.body.query;
      if (query.startsWith('mutation')) writes.push({ path, ...options });
      if (query.includes('markPullRequestReadyForReview')) {
        candidate.draft = false;
        const run = observation.runs[0];
        observation.jobs[run.id + 100] = observation.jobs[run.id];
        run.id += 100;
        return { data: { markPullRequestReadyForReview: { pullRequest: { id: candidate.node_id, isDraft: false, headRefOid: head } } } };
      }
      if (query.includes('enqueuePullRequest')) {
        queued = true;
        return { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'QUEUE_99', state: 'QUEUED' } } } };
      }
      if (queued && harness.mergeAfterEnqueue) merged = true;
      return { data: { repository: { pullRequest: { state: merged ? 'MERGED' : 'OPEN', headRefOid: head, merged,
        mergeCommit: merged ? { oid: merge } : null, mergeQueueEntry: queued && !merged ? { id: 'QUEUE_99', state: 'QUEUED' } : null } } } };
    }
    if (options.method === 'PUT') {
      assert.equal(path, `${route}/pulls/99/merge`);
      writes.push({ path, ...options });
      merged = true;
      return { merged: true, sha: merge };
    }
    assert.equal(options.method ?? 'GET', 'GET');
    if (path === route) return observation.repository;
    if (path === `${route}/pulls/99`) return { ...structuredClone(candidate), ...(merged ? { merged: true, state: 'closed', merge_commit_sha: merge } : {}) };
    if (path.startsWith(`${route}/branches/`)) return { commit: { sha: merged ? merge : candidate.base.sha } };
    if (path === `${route}/rules/branches/${target}`) return observation.rules;
    if (path.includes('/files?')) return observation.changedPaths.map((filename) => ({ filename }));
    if (path.includes('/actions/runs?')) return { workflow_runs: structuredClone(observation.runs) };
    if (path.includes('/check-runs?')) return { check_runs: observation.checks };
    if (path.includes('/jobs?')) return { jobs: observation.jobs[Number(path.match(/runs\/(\d+)/u)[1])] };
    if (path.includes('/commits/')) {
      const sha = path.split('/').at(-1);
      return sha === observation.sourceCommit.sha ? observation.sourceCommit : { sha, commit: { tree: { sha: observation.promotion.sourceTree } } };
    }
    if (path.includes('/compare/')) return { status: 'identical' };
    throw new Error(`Unexpected request ${path}`);
  };
  return Object.assign(harness, { api, readArtifact: (run) => {
    artifactRuns.push(run.id);
    return { value: observation.qualification, artifact: { id: 99 } };
  } });
}

test('preparation is read-only; delivery needs no recurring authorization flag', () => {
  assert.equal(parseArguments(['--pr', '99']).command, 'inspect');
  assert.equal(parseArguments(['prepare', '--pr', '99']).command, 'prepare');
  assert.equal(parseArguments(['--deliver']).command, 'deliver');
  assert.throws(() => parseArguments(['deliver', '--pr', '99', '--authorize-merge']), /Invalid option/u);
});

test('inspection preserves a draft and observes both sides of a rename', () => {
  const harness = apiFixture();
  harness.candidate.draft = true;
  const api = (path, options) => path.includes('/files?')
    ? [{ filename: 'README.md', previous_filename: 'apps/desktop/src/App.tsx' }]
    : harness.api(path, options);
  const receipt = inspectPullRequest(99, { ...harness, api });
  assert.equal(receipt.decision.state, 'rejected');
  assert(receipt.decision.reasons.includes('Pull request is held as a draft'));
  assert.deepEqual(receipt.observation.changedPaths, ['README.md', 'apps/desktop/src/App.tsx']);
  assert.equal(harness.candidate.draft, true);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.calls.filter((call) => call.path === `${route}/pulls/99`).length, 2);
});

test('explicit enqueue preserves a draft without a write', () => {
  const harness = apiFixture();
  harness.candidate.draft = true;
  const receipt = enqueueQualifiedPullRequest(99, { ...harness, ...local });
  assert.equal(receipt.decision.state, 'rejected');
  assert.equal(harness.writes.length, 0);
});

test('enqueue without an exact head performs no provider operation', () => {
  const api = () => { throw new Error('provider must not be called'); };
  assert.throws(() => enqueueQualifiedPullRequest(99, { api }), /expected-head/u);
});

test('argument parsing rejects malformed and duplicate input', () => {
  for (const args of [[], ['inspect', '--pr', 'NaN'], ['prepare', '--pr', '1', '--pr', '2'], ['inspect', '--wat'], ['delete', '--pr', '1'], ['promote', '--pr', '99']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('development uses the latest failed preflight and never downloads broad evidence', () => {
  const harness = apiFixture();
  harness.observation.runs.push({ ...harness.observation.runs[0], id: 100, conclusion: 'failure' });
  harness.observation.jobs[100] = [];
  const receipt = enqueueQualifiedPullRequest(99, { ...harness, ...local });
  assert.equal(receipt.decision.state, 'rejected');
  assert.deepEqual(harness.artifactRuns, []);
  assert.deepEqual(harness.writes, []);
});

test('an off-repository workflow cannot enqueue', () => {
  const harness = apiFixture();
  harness.observation.runs[1].workflow_url = 'https://api.github.com/repos/example/fork/actions/workflows/11';
  const receipt = enqueueQualifiedPullRequest(99, { ...harness, ...local });
  assert.equal(receipt.decision.state, 'pending');
  assert.equal(receipt.decision.runs[policy.authority.claWorkflow], null);
  assert.deepEqual(harness.writes, []);
});

test('qualified admission sends one exact-head queue mutation', () => {
  const harness = apiFixture();
  const receipt = enqueueQualifiedPullRequest(99, { ...harness, ...local });
  assert.equal(receipt.admission.state, 'enqueued');
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.writes[0].body.variables, { id: 'PR_example', head });
  assert.match(harness.writes[0].body.query, /enqueuePullRequest/u);
  assert.doesNotMatch(harness.writes[0].body.query, /autoMerge|jump|mergePullRequest/u);
});

test('qualified remote result cannot admit a dirty or different local checkout', () => {
  for (const override of [{ localHead: 'f'.repeat(40) }, { localStatus: ' M file' }]) {
    const harness = apiFixture();
    assert.throws(() => enqueueQualifiedPullRequest(99, { ...harness, ...local, ...override }), /clean local checkout/u);
    assert.equal(harness.calls.length, 0);
  }
});

test('deliver readies once, waits for the new preflight and verifies the target merge', async () => {
  const harness = apiFixture();
  harness.candidate.draft = true;
  const receipt = await deliverPullRequest(99, { ...harness, ...local });
  assert.equal(receipt.delivery.mergeCommit, merge);
  assert.equal(receipt.delivery.target, 'dev');
  assert.equal(harness.writes.length, 2);
  assert.match(harness.writes[0].body.query, /markPullRequestReadyForReview/u);
  assert.match(harness.writes[1].body.query, /enqueuePullRequest/u);
  assert.deepEqual(harness.artifactRuns, []);
});

test('explicit labels preserve a hold even for a draft deliver request', async () => {
  const harness = apiFixture();
  harness.candidate.draft = true;
  harness.candidate.labels = [{ name: 'merge-hold' }];
  await assert.rejects(deliverPullRequest(99, { ...harness, ...local }), /explicit merge hold/u);
  assert.equal(harness.writes.length, 0);
});

test('a watcher timeout leaves its existing queue entry unchanged', async () => {
  const harness = apiFixture();
  harness.mergeAfterEnqueue = false;
  let elapsed = 0;
  await assert.rejects(deliverPullRequest(99, { ...harness, ...local, now: () => elapsed, sleep: async () => { elapsed += 2; }, maxWaitMs: 1, pollIntervalMs: 1 }), /watch timed out/u);
  assert.equal(harness.writes.length, 1);
  assert.match(harness.writes[0].body.query, /enqueuePullRequest/u);
});

test('a dropped queue entry is not automatically re-enqueued', async () => {
  const harness = apiFixture();
  harness.mergeAfterEnqueue = false;
  const api = (path, options) => {
    const result = harness.api(path, options);
    if (result.data?.repository?.pullRequest) result.data.repository.pullRequest.mergeQueueEntry = null;
    return result;
  };
  await assert.rejects(deliverPullRequest(99, { ...harness, ...local, api }), /refusing automatic re-enqueue/u);
  assert.equal(harness.writes.length, 1);
});

test('watcher request limits fail closed before admission', async () => {
  const harness = apiFixture();
  await assert.rejects(deliverPullRequest(99, { ...harness, ...local, maxRequests: 1 }), /request budget exhausted/u);
  assert.equal(harness.writes.length, 0);
});

test('inspection refuses a retarget to another branch at the same base commit', () => {
  const harness = apiFixture();
  let reads = 0;
  const api = (path, options) => {
    const result = harness.api(path, options);
    if (path === `${route}/pulls/99` && ++reads === 2) result.base.ref = 'staging';
    return result;
  };
  const receipt = enqueueQualifiedPullRequest(99, { ...harness, ...local, api });
  assert.equal(receipt.decision.state, 'pending');
  assert(receipt.decision.reasons.some((reason) => reason.includes('changed during inspection')));
  assert.equal(harness.writes.length, 0);
});

test('promotion reads the distinct selected source ancestry and refuses an unrelated same-tree head', () => {
  const harness = apiFixture('staging');
  const sourceSha = '6'.repeat(40);
  const comparison = `${route}/compare/${sourceSha}...${head}`;
  let observed = false;
  const api = (path, options) => {
    if (path === comparison) {
      observed = true;
      return { status: 'diverged' };
    }
    return harness.api(path, options);
  };
  const receipt = promoteQualifiedPullRequest(99, { ...harness, ...local, api, sourceSha });
  assert.equal(observed, true);
  assert.equal(receipt.observation.promotion.headTree, receipt.observation.promotion.sourceTree);
  assert.equal(receipt.decision.state, 'rejected');
  assert(receipt.decision.reasons.includes('Promotion PR does not preserve selected source ancestry'));
  assert.equal(harness.writes.length, 0);
});

for (const target of ['staging', 'prod']) {
  test(`${target} promotion uses a merge commit and verifies its selected tree without publishing`, () => {
    const harness = apiFixture(target);
    const receipt = promoteQualifiedPullRequest(99, { ...harness, ...local, sourceSha: head });
    assert.equal(receipt.decision.state, 'qualified');
    assert.equal(receipt.delivery.target, target);
    assert.equal(receipt.delivery.mergeCommit, merge);
    assert.equal(receipt.publication, 'not-requested');
    assert.deepEqual(harness.writes.map(({ path, method, body }) => ({ path, method, body })), [
      { path: `${route}/pulls/99/merge`, method: 'PUT', body: { sha: head, merge_method: 'merge' } },
    ]);
    assert.equal(branchPolicy(target).upstream, target === 'staging' ? 'dev' : 'staging');
  });
}
