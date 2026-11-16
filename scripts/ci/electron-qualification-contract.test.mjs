import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const url = process.env.DNAFORGE_QUALIFICATION_SUBJECT_ROOT
  ? pathToFileURL(resolve(process.env.DNAFORGE_QUALIFICATION_SUBJECT_ROOT, 'scripts/ci/electron-qualification.mjs'))
  : new URL('./electron-qualification.mjs', import.meta.url);
const subject = await import(url.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const operation = () => {
  assert.equal(typeof subject.validateElectronQualification, 'function', 'Missing source-bound Electron qualification operation');
  return subject.validateElectronQualification;
};
const sha = (letter) => letter.repeat(40);
const H = sha('1'), B = sha('2'), M = sha('3'), T = sha('4'), C = sha('5'), CT = sha('6');
const schema = 'dnaforge.public-electron-qualification.v1';
const appId = 912345;
const hash = (text) => createHash('sha256').update(text).digest('hex');

function fixture(target = 'staging') {
  const receipt = {
    schema,
    repository: 'humic-labs/dnaforge-app',
    repositoryId: 1454956566,
    pullRequest: 99,
    target,
    headSha: H,
    baseSha: B,
    mergeSha: M,
    treeSha: T,
    controller: { commit: C, tree: CT },
    run: { id: 456, attempt: 2, workflow: '.github/workflows/e2e-electron.yml' },
    rosterSha256: '7'.repeat(64),
    evidenceSha256: '8'.repeat(64),
    status: 'passed',
    counts: { passed: 4, skipped: 0, flaky: 0, failedAttempts: 0, reports: 4 },
  };
  const candidate = { number: 99, base: { ref: target, sha: B, repo: { id: 1454956566 } }, head: { sha: H } };
  const qualification = { sourceSha: M, sourceTree: T, baseSha: B, status: 'passed' };
  const text = JSON.stringify(receipt);
  const check = { name: 'Electron E2E', head_sha: H, app: { id: appId }, status: 'completed', conclusion: 'success', external_id: `${schema}:${hash(text)}`, details_url: 'https://github.com/humic-labs/dnaforge/actions/runs/456/attempts/2', output: { text } };
  return { receipt, check, candidate, qualification, appId };
}
function rebind(fixture) {
  fixture.check.output.text = JSON.stringify(fixture.receipt);
  fixture.check.external_id = `${schema}:${hash(fixture.check.output.text)}`;
}

for (const target of ['staging', 'prod']) test(`exact ${target} candidate accepts the real app's source-bound receipt`, () => {
  const f = fixture(target);
  assert.deepEqual(operation()(f.check, f), f.receipt);
});

for (const [name, mutate] of [
  ['wrong schema', (f) => { f.receipt.schema = 'untrusted.v1'; }],
  ['private repository source', (f) => { f.receipt.repository = 'humic-labs/dnaforge'; }],
  ['wrong public repository ID', (f) => { f.receipt.repositoryId++; }],
  ['wrong pull request', (f) => { f.receipt.pullRequest++; }],
  ['wrong target branch', (f) => { f.receipt.target = 'prod'; }],
  ['stale public head', (f) => { f.receipt.headSha = sha('a'); }],
  ['stale public base', (f) => { f.receipt.baseSha = sha('a'); }],
  ['wrong tested merge commit', (f) => { f.receipt.mergeSha = sha('a'); }],
  ['wrong tested tree', (f) => { f.receipt.treeSha = sha('a'); }],
  ['missing private controller commit', (f) => { delete f.receipt.controller.commit; }],
  ['missing private controller tree', (f) => { delete f.receipt.controller.tree; }],
  ['wrong private workflow', (f) => { f.receipt.run.workflow = '.github/workflows/subset.yml'; }],
  ['invalid private run', (f) => { f.receipt.run.id = 0; }],
  ['missing run attempt', (f) => { delete f.receipt.run.attempt; }],
  ['invalid roster binding', (f) => { f.receipt.rosterSha256 = 'unknown'; }],
  ['missing report binding', (f) => { delete f.receipt.evidenceSha256; }],
  ['failed receipt', (f) => { f.receipt.status = 'failed'; }],
  ['empty passing test count', (f) => { f.receipt.counts.passed = 0; }],
  ['empty report count', (f) => { f.receipt.counts.reports = 0; }],
]) test(`source-bound admission refuses ${name} even with matching receipt hash`, () => {
  const validate = operation();
  const f = fixture();
  mutate(f);
  rebind(f);
  assert.throws(() => validate(f.check, f));
});

for (const [name, mutate] of [
  ['other publishing app', (f) => { f.check.app.id++; }],
  ['different check name', (f) => { f.check.name = 'Public subset'; }],
  ['different check head', (f) => { f.check.head_sha = sha('a'); }],
  ['pending check', (f) => { f.check.status = 'in_progress'; }],
  ['skipped check', (f) => { f.check.conclusion = 'skipped'; }],
  ['failed check', (f) => { f.check.conclusion = 'failure'; }],
  ['missing receipt', (f) => { delete f.check.output; }],
  ['invalid JSON', (f) => { f.check.output.text = '{'; }],
  ['oversized JSON', (f) => { f.check.output.text = JSON.stringify({ padding: 'x'.repeat(1_000_000) }); }],
  ['altered receipt bytes', (f) => { f.check.output.text += ' '; }],
  ['unbound external identity', (f) => { f.check.external_id = `${schema}:` + '0'.repeat(64); }],
  ['different details run', (f) => { f.check.details_url = 'https://github.com/humic-labs/dnaforge/actions/runs/457/attempts/2'; }],
  ['different details attempt', (f) => { f.check.details_url = 'https://github.com/humic-labs/dnaforge/actions/runs/456/attempts/1'; }],
  ['foreign details repository', (f) => { f.check.details_url = 'https://github.com/other/repository/actions/runs/456/attempts/2'; }],
  ['retargeted current candidate', (f) => { f.candidate.base.ref = 'prod'; }],
  ['moved current base', (f) => { f.candidate.base.sha = sha('a'); }],
  ['broad qualification tests another tree', (f) => { f.qualification.sourceTree = sha('a'); }],
  ['broad qualification tests another merge', (f) => { f.qualification.sourceSha = sha('a'); }],
  ['broad qualification tests another base', (f) => { f.qualification.baseSha = sha('a'); }],
]) test(`source-bound admission refuses ${name}`, () => {
  const validate = operation();
  const f = fixture();
  mutate(f);
  assert.throws(() => validate(f.check, f));
});
