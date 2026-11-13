import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function testInstallLogMarkers(content, mustContain = [], mustNotContain = []) {
  const missing = [];
  for (const marker of mustContain) {
    if (!content.includes(marker)) missing.push(marker);
  }
  const unexpected = [];
  for (const marker of mustNotContain) {
    if (content.includes(marker)) unexpected.push(marker);
  }
  return {
    Ok: missing.length === 0 && unexpected.length === 0,
    Missing: missing,
    Unexpected: unexpected,
  };
}

describe('Test-InstallLogMarkers behavioral fixtures ', () => {
  it('T1 happy path: schema + init + complete → pass', () => {
    const content =
      'schema=1 event=init ts=2026-07-08T00:00:00 version=0.3.0\n' +
      'schema=1 event=install_complete ts=2026-07-08T00:00:01 version=0.3.0\n';
    const check = testInstallLogMarkers(content, [
      'schema=1',
      'event=init',
      'event=install_complete',
    ]);
    assert.equal(check.Ok, true);
  });

  it('T2 failure path: init only → pass; init+complete → fail', () => {
    const initOnly = 'schema=1 event=init ts=2026-07-08T00:00:00 version=0.3.0\n';
    const pass = testInstallLogMarkers(initOnly, ['event=init'], ['event=install_complete']);
    assert.equal(pass.Ok, true);

    const withComplete = initOnly + 'schema=1 event=install_complete ts=2026-07-08T00:00:01\n';
    const fail = testInstallLogMarkers(withComplete, ['event=init'], ['event=install_complete']);
    assert.equal(fail.Ok, false);
    assert.ok(fail.Unexpected.includes('event=install_complete'));
  });

  it('empty content fails required markers', () => {
    const check = testInstallLogMarkers('', ['event=init']);
    assert.equal(check.Ok, false);
    assert.ok(check.Missing.includes('event=init'));
  });

  it('dual-write init-only: rejects install_complete', () => {
    const dual = 'schema=1 event=init ts=x version=y\n';
    const ok = testInstallLogMarkers(dual, ['event=init'], ['event=install_complete']);
    assert.equal(ok.Ok, true);
    const bad = testInstallLogMarkers(
      dual + 'event=install_complete\n',
      ['event=init'],
      ['event=install_complete']
    );
    assert.equal(bad.Ok, false);
  });
});
