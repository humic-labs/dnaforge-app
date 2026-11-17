import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const schema = 'dnaforge.public-electron-qualification.v2';
const sha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function validateElectronQualification(check, { candidate, qualification, appId }) {
  assert.ok(positive(appId), 'Electron publisher identity is missing');
  assert.equal(check?.app?.id, appId, 'Electron publisher differs from policy');
  assert.equal(check.name, 'Electron E2E', 'Unexpected Electron check');
  assert.equal(check.status, 'completed', 'Electron check is incomplete');
  assert.equal(check.conclusion, 'success', 'Electron check did not pass');
  assert.equal(check.head_sha, candidate?.head?.sha, 'Electron check has another head');
  assert.equal(candidate?.base?.repo?.id, 1454956566, 'Unexpected public repository');
  assert.ok(positive(candidate.number), 'Public pull request is missing');
  assert.ok(['staging', 'prod'].includes(candidate.base.ref), 'Unexpected promotion target');
  assert.equal(qualification?.status, 'passed', 'Broad qualification did not pass');
  const text = check.output?.text;
  assert.ok(
    typeof text === 'string' && Buffer.byteLength(text) <= 65536,
    'Electron receipt is missing or oversized'
  );
  assert.equal(
    check.external_id,
    `${schema}:${createHash('sha256').update(text).digest('hex')}`,
    'Electron receipt digest differs'
  );
  const receipt = JSON.parse(text);
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt));
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      'schema',
      'repository',
      'repositoryId',
      'pullRequest',
      'target',
      'headSha',
      'baseSha',
      'mergeSha',
      'treeSha',
      'status',
      'counts',
      'rosterSha256',
      'evidenceSha256',
      'proofSha256',
    ].sort(),
    'Electron receipt fields differ from the public contract'
  );
  assert.equal(receipt?.schema, schema, 'Unsupported Electron receipt');
  assert.equal(receipt.repository, 'humic-labs/dnaforge-app', 'Electron source repository differs');
  assert.equal(
    receipt.repositoryId,
    candidate.base.repo.id,
    'Electron repository identity differs'
  );
  assert.equal(receipt.pullRequest, candidate.number, 'Electron pull request differs');
  assert.equal(receipt.target, candidate.base.ref, 'Electron target differs');
  for (const [key, expected] of [
    ['headSha', candidate.head.sha],
    ['baseSha', candidate.base.sha],
    ['mergeSha', qualification.sourceSha],
    ['treeSha', qualification.sourceTree],
  ]) {
    assert.match(expected, sha, `Invalid expected ${key}`);
    assert.equal(receipt[key], expected, `Electron ${key} differs`);
  }
  assert.equal(
    receipt.baseSha,
    qualification.baseSha,
    'Electron and broad qualification bases differ'
  );
  assert.equal(
    check.details_url,
    `https://github.com/humic-labs/dnaforge-app/commit/${receipt.headSha}/checks`,
    'Electron source link differs'
  );
  assert.match(receipt.proofSha256 ?? '', digest, 'Electron proof binding is missing');
  assert.match(receipt.rosterSha256 ?? '', digest, 'Electron roster binding is missing');
  assert.match(receipt.evidenceSha256 ?? '', digest, 'Electron evidence binding is missing');
  assert.equal(receipt.status, 'passed', 'Electron receipt did not pass');
  assert.ok(receipt.counts && typeof receipt.counts === 'object' && !Array.isArray(receipt.counts));
  assert.deepEqual(
    Object.keys(receipt.counts).sort(),
    ['passed', 'skipped', 'flaky', 'failedAttempts', 'reports'].sort(),
    'Electron counts differ from the public contract'
  );
  assert.ok(
    positive(receipt.counts?.passed) && positive(receipt.counts?.reports),
    'Electron evidence is empty'
  );
  for (const key of ['skipped', 'flaky', 'failedAttempts'])
    assert.ok(
      Number.isSafeInteger(receipt.counts[key]) && receipt.counts[key] >= 0,
      `Invalid Electron ${key}`
    );
  return receipt;
}
