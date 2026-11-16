import assert from 'node:assert/strict';
import test from 'node:test';
import { assessQualification, branchPolicy, policy, proposedRules, selectRequiredWork } from './merge-policy.mjs';
import { qualifiedFixture } from './delivery-fixture.mjs';

test('only explicit documentation paths omit native journeys', () => {
  assert.equal(selectRequiredWork(['README.md', 'docs/ci/policy.md']).nativeRequired, false);
  assert.deepEqual(selectRequiredWork(['apps/desktop/src/App.tsx']).journeys, policy.native.journeys);
  for (const path of ['.github/workflows/ci.yml', 'skills/verify-public-delivery/drive.mjs', 'unclassified.md']) assert.equal(selectRequiredWork([path]).kind, 'code');
  assert.throws(() => selectRequiredWork([]), /nonempty/u);
});

test('rules declare separate dev and promotion policies without approvals or bypasses', () => {
  const proposal = proposedRules();
  assert.equal(proposal.state, 'proposal-only');
  assert.deepEqual(proposal.repositories.map((entry) => entry.target), ['dev', 'staging', 'prod']);
  assert.equal(proposal.organization, undefined);
  for (const item of proposal.repositories) {
    assert.deepEqual(item.body.bypass_actors, []);
    const pr = item.body.rules.find((rule) => rule.type === 'pull_request').parameters;
    assert.equal(pr.required_approving_review_count, 0);
    for (const key of ['require_code_owner_review', 'require_last_push_approval', 'require_extra_approval_for_unattributed_changes']) assert.equal(pr[key], false);
    const checks = item.body.rules.find((rule) => rule.type === 'required_status_checks').parameters;
    assert.deepEqual(checks.required_status_checks.map((check) => check.context), branchPolicy(item.target).requiredChecks);
    assert(checks.required_status_checks.every((check) => check.integration_id === 15368));
    assert.equal(item.body.rules.some((rule) => rule.type === 'merge_queue'), item.target === 'dev');
  }
});

test('development uses its fast checks without broad qualification artifacts', () => {
  const { candidate, observation } = qualifiedFixture('dev');
  delete observation.qualification;
  delete observation.promotion;
  assert.equal(assessQualification(candidate, observation).state, 'qualified');
});

for (const target of ['staging', 'prod']) test(`complete exact-source ${target} promotion qualifies`, () => {
  const { candidate, observation } = qualifiedFixture(target);
  assert.equal(assessQualification(candidate, observation).state, 'qualified');
});

test('latest valid ordinary workflow wins and an earlier success cannot mask its failure', () => {
  const { candidate, observation } = qualifiedFixture();
  observation.runs.push({ ...observation.runs[0], id: 100, conclusion: 'failure' });
  assert.equal(assessQualification(candidate, observation).state, 'rejected');
});

for (const [name, mutate] of [
  ['draft', (c) => { c.draft = true; }],
  ['explicit hold', (c) => { c.labels = [{ name: 'DO-NOT-MERGE' }]; }],
  ['stale expected head', (c) => { c.expectedHead = 'f'.repeat(40); }],
  ['wrong repository', (c, o) => { o.repository.id = 1; }],
  ['unsupported main target', (c) => { c.base.ref = 'main'; }],
  ['missing PR rule', (c, o) => { o.rules = o.rules.filter((r) => r.type !== 'pull_request'); }],
  ['unbound publisher', (c, o) => { o.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = null; }],
  ['skipped required check', (c, o) => { o.checks[1].conclusion = 'skipped'; }],
  ['cancelled current job', (c, o) => { o.jobs[10][0].conclusion = 'cancelled'; }],
  ['old run attempt receipt', (c, o) => { o.qualification.attempt = 1; }],
  ['wrong tested tree', (c, o) => { o.qualification.sourceTree = 'a'.repeat(40); }],
  ['different PR tested', (c, o) => { o.sourceCommit.parents[1].sha = 'a'.repeat(40); }],
  ['untrusted control revision', (c, o) => { o.ancestry.control = 'diverged'; }],
  ['missing control workflow', (c, o) => { delete o.qualification.controlRef; }],
  ['candidate-owned control workflow', (c, o) => { o.qualification.controlRef = `${policy.repository.name}/${branchPolicy(c.base.ref).workflow}@refs/pull/99/merge`; }],
  ['coverage weakened by candidate', (c, o) => { o.qualification.coverage = selectRequiredWork(['README.md']); }],
  ['zero tests', (c, o) => { o.qualification.desktop.passed = 0; }],
  ['wrong upstream', (c, o) => { o.promotion.ancestry = 'diverged'; }],
  ['extra promotion edits', (c, o) => { o.promotion.headTree = 'f'.repeat(40); }],
  ['wrong selected source', (c) => { c.expectedSource = 'f'.repeat(40); }],
  ['failed external Electron matrix', (c, o) => { o.checks[2].conclusion = 'failure'; }],
]) test(`rejects ${name}`, () => {
  const { candidate, observation } = qualifiedFixture();
  mutate(candidate, observation);
  assert.equal(assessQualification(candidate, observation).state, 'rejected');
});

test('development refuses missing queue', () => {
  const { candidate, observation } = qualifiedFixture('dev');
  observation.rules = observation.rules.filter((rule) => rule.type !== 'merge_queue');
  assert.equal(assessQualification(candidate, observation).state, 'rejected');
});

for (const workflowUrl of [
  'https://api.github.com/repos/other/repository/actions/workflows/10',
  `https://api.github.com/repos/${policy.repository.name}/actions/workflows/10/other`,
  undefined,
]) test(`does not qualify an unbound workflow ${workflowUrl}`, () => {
  const { candidate, observation } = qualifiedFixture();
  observation.runs[0].workflow_url = workflowUrl;
  delete observation.qualification;
  assert.equal(assessQualification(candidate, observation).state, 'pending');
});

for (const [name, mutate] of [
  ['missing check', (o) => { o.checks.pop(); }],
  ['check from another publisher', (o) => { o.checks[1].app.id = 1; }],
  ['check from another suite', (o) => { o.checks[1].check_suite.id = 1; }],
  ['external result from another commit', (o) => { o.checks[2].head_sha = 'f'.repeat(40); }],
  ['external result from another publisher', (o) => { o.checks[2].app.id = 1; }],
  ['missing current attempt job', (o) => { o.jobs[10] = []; }],
  ['missing artifact', (o) => { delete o.qualification; }],
  ['changing observation', (o) => { o.errors.push('Pull request changed during inspection'); }],
]) test(`does not qualify ${name}`, () => {
  const { candidate, observation } = qualifiedFixture();
  mutate(observation);
  assert.equal(assessQualification(candidate, observation).state, 'pending');
});
