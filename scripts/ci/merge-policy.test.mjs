import assert from 'node:assert/strict';
import test from 'node:test';
import { assessQualification, policy, proposedRules, selectRequiredWork } from './merge-policy.mjs';

import { qualifiedFixture } from './delivery-fixture.mjs';

test('only explicit documentation paths omit native journeys', () => {
  assert.equal(selectRequiredWork(['README.md', 'docs/ci/policy.md']).nativeRequired, false);
  assert.deepEqual(selectRequiredWork(['apps/desktop/src/App.tsx']).journeys, policy.native.journeys);
  assert.equal(selectRequiredWork(['.github/workflows/ci.yml']).kind, 'code');
  assert.equal(selectRequiredWork(['skills/verify-public-delivery/drive.mjs']).kind, 'code');
  assert.equal(selectRequiredWork(['unclassified.md']).kind, 'code');
  assert.throws(() => selectRequiredWork([]), /nonempty/u);
});

test('proposed configuration preserves all old contexts and requires no approval or bypass', () => {
  const proposal = proposedRules();
  assert.equal(proposal.state, 'proposal-only');
  assert.deepEqual(proposal.repository.body.bypass_actors, []);
  assert.deepEqual(proposal.organization.body.bypass_actors, []);
  const rule = proposal.repository.body.rules.find((entry) => entry.type === 'pull_request');
  assert.equal(rule.parameters.required_approving_review_count, 0);
  assert.equal(rule.parameters.require_code_owner_review, false);
  assert.equal(rule.parameters.require_last_push_approval, false);
  assert.equal(rule.parameters.require_extra_approval_for_unattributed_changes, false);
  assert.equal(proposal.organization.body.rules[0].parameters.workflows[0].repository_id, policy.repository.id);
});

test('a complete source-bound observation qualifies', () => {
  const { candidate, observation } = qualifiedFixture();
  assert.equal(assessQualification(candidate, observation).state, 'qualified');
});

for (const [name, mutate] of [
  ['draft', (c) => { c.draft = true; }],
  ['explicit hold', (c) => { c.labels = [{ name: 'DO-NOT-MERGE' }]; }],
  ['stale expected head', (c) => { c.expectedHead = 'f'.repeat(40); }],
  ['wrong repository', (c, o) => { o.repository.id = 1; }],
  ['missing queue', (c, o) => { o.rules = o.rules.filter((r) => r.type !== 'merge_queue'); }],
  ['missing PR rule', (c, o) => { o.rules = o.rules.filter((r) => r.type !== 'pull_request'); }],
  ['unbound publisher', (c, o) => { o.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = null; }],
  ['missing required workflow', (c, o) => { o.rules = o.rules.filter((r) => r.type !== 'workflows'); }],
  ['skipped required check', (c, o) => { o.checks[1].conclusion = 'skipped'; }],
  ['cancelled current job', (c, o) => { o.jobs[10][0].conclusion = 'cancelled'; }],
  ['old run attempt receipt', (c, o) => { o.qualification.attempt = 1; }],
  ['wrong tested tree', (c, o) => { o.qualification.sourceTree = 'a'.repeat(40); }],
  ['different PR tested', (c, o) => { o.sourceCommit.parents[1].sha = 'a'.repeat(40); }],
  ['untrusted control revision', (c, o) => { o.ancestry.control = 'diverged'; }],
  ['coverage weakened by candidate', (c, o) => { o.qualification.coverage = selectRequiredWork(['README.md']); }],
  ['zero tests', (c, o) => { o.qualification.desktop.passed = 0; }],
  ['new failed run despite old success', (c, o) => { o.runs.push({ ...o.runs[0], id: 100, conclusion: 'failure' }); }],
]) {
  test(`rejects ${name}`, () => {
    const { candidate, observation } = qualifiedFixture();
    mutate(candidate, observation);
    assert.equal(assessQualification(candidate, observation).state, 'rejected');
  });
}

for (const [name, mutate] of [
  ['missing check', (o) => { o.checks.pop(); }],
  ['check from another publisher', (o) => { o.checks[1].app.id = 1; }],
  ['check from another suite', (o) => { o.checks[1].check_suite.id = 1; }],
  ['missing current attempt job', (o) => { o.jobs[10] = []; }],
  ['missing artifact', (o) => { delete o.qualification; }],
  ['changing observation', (o) => { o.errors.push('Pull request changed during inspection'); }],
]) {
  test(`does not qualify ${name}`, () => {
    const { candidate, observation } = qualifiedFixture();
    mutate(observation);
    assert.equal(assessQualification(candidate, observation).state, 'pending');
  });
}
