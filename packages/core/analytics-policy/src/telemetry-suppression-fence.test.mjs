import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  clearTelemetrySuppressionFence,
  resolveTelemetrySuppressionFence,
  telemetrySuppressionFencePath,
  writeTelemetrySuppressionFence,
} from './telemetry-suppression-fence.mjs';

const roots = [];

function temporaryUserData() {
  const root = mkdtempSync(join(tmpdir(), 'dnaforge-telemetry-fence-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('telemetry suppression fence', () => {
  it('atomically writes and resolves one bounded suppression-only lease', () => {
    const userDataPath = temporaryUserData();
    const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
    const lease = writeTelemetrySuppressionFence({
      userDataPath,
      reason: 'packaged_update_test',
      nowMs,
      expiresAtMs: nowMs + 60 * 60 * 1_000,
    });

    assert.equal(lease.path, telemetrySuppressionFencePath(userDataPath));
    assert.deepEqual(resolveTelemetrySuppressionFence({ userDataPath, nowMs }), {
      kind: 'active',
      path: lease.path,
      reason: 'packaged_update_test',
      leaseId: lease.leaseId,
      expiresAtMs: nowMs + 60 * 60 * 1_000,
    });
    assert.equal(JSON.parse(readFileSync(lease.path, 'utf8')).actor, undefined);
    assert.equal(clearTelemetrySuppressionFence({ userDataPath, leaseId: lease.leaseId }), true);
    assert.equal(resolveTelemetrySuppressionFence({ userDataPath, nowMs }).kind, 'absent');
  });

  it('refuses to replace or clear another active lease', () => {
    const userDataPath = temporaryUserData();
    const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
    const lease = writeTelemetrySuppressionFence({
      userDataPath,
      reason: 'packaged_validation_test',
      nowMs,
      expiresAtMs: nowMs + 60_000,
    });

    assert.throws(
      () =>
        writeTelemetrySuppressionFence({
          userDataPath,
          reason: 'packaged_update_test',
          nowMs,
          expiresAtMs: nowMs + 60_000,
        }),
      /already exists/
    );
    assert.equal(
      clearTelemetrySuppressionFence({
        userDataPath,
        leaseId: '00000000-0000-4000-8000-000000000000',
      }),
      false
    );
    assert.equal(clearTelemetrySuppressionFence({ userDataPath, leaseId: lease.leaseId }), true);
  });

  it('removes an expired regular fence and returns to ordinary capture', () => {
    const userDataPath = temporaryUserData();
    const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
    writeTelemetrySuppressionFence({
      userDataPath,
      reason: 'packaged_update_test',
      nowMs,
      expiresAtMs: nowMs + 1_000,
    });
    assert.equal(
      resolveTelemetrySuppressionFence({ userDataPath, nowMs: nowMs + 1_001 }).kind,
      'expired'
    );
    assert.equal(resolveTelemetrySuppressionFence({ userDataPath, nowMs }).kind, 'absent');
  });

  it('fails closed for malformed, oversized, and symlink fences', () => {
    const malformedRoot = temporaryUserData();
    writeFileSync(telemetrySuppressionFencePath(malformedRoot), '{');
    assert.equal(resolveTelemetrySuppressionFence({ userDataPath: malformedRoot }).kind, 'active');

    const oversizedRoot = temporaryUserData();
    writeFileSync(telemetrySuppressionFencePath(oversizedRoot), 'x'.repeat(2_049));
    assert.equal(resolveTelemetrySuppressionFence({ userDataPath: oversizedRoot }).kind, 'active');

    const symlinkRoot = temporaryUserData();
    const target = join(symlinkRoot, 'target');
    writeFileSync(target, '{}');
    symlinkSync(target, telemetrySuppressionFencePath(symlinkRoot));
    assert.equal(resolveTelemetrySuppressionFence({ userDataPath: symlinkRoot }).kind, 'active');
  });
});
