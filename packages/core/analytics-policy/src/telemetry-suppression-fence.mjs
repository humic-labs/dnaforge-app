import { lstatSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FENCE_FILE = 'telemetry-suppression-fence.json';
const MAX_FENCE_BYTES = 2_048;
const MAX_FENCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const VALID_REASONS = new Set(['packaged_update_test', 'packaged_validation_test']);
const LEASE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function telemetrySuppressionFencePath(userDataPath) {
  return join(userDataPath, FENCE_FILE);
}

function removeRegularFile(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {}
}

export function resolveTelemetrySuppressionFence({ userDataPath, nowMs = Date.now() }) {
  const path = telemetrySuppressionFencePath(userDataPath);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_FENCE_BYTES) {
      return { kind: 'active', path, reason: 'invalid_fence' };
    }
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.schema !== 1 ||
      !VALID_REASONS.has(value.reason) ||
      typeof value.lease_id !== 'string' ||
      !LEASE_ID_RE.test(value.lease_id) ||
      !Number.isSafeInteger(value.created_at_ms) ||
      !Number.isSafeInteger(value.expires_at_ms) ||
      value.expires_at_ms <= value.created_at_ms ||
      value.expires_at_ms - value.created_at_ms > MAX_FENCE_LIFETIME_MS ||
      value.created_at_ms > nowMs + 5 * 60 * 1_000
    ) {
      return { kind: 'active', path, reason: 'invalid_fence' };
    }
    if (value.expires_at_ms <= nowMs) {
      removeRegularFile(path);
      return { kind: 'expired', path };
    }
    return {
      kind: 'active',
      path,
      reason: value.reason,
      leaseId: value.lease_id,
      expiresAtMs: value.expires_at_ms,
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'active', path, reason: 'invalid_fence' };
  }
}

export function writeTelemetrySuppressionFence({
  userDataPath,
  reason,
  expiresAtMs,
  nowMs = Date.now(),
}) {
  if (
    !VALID_REASONS.has(reason) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > MAX_FENCE_LIFETIME_MS
  ) {
    throw new Error('Telemetry suppression fence requires a bounded reason and future expiry');
  }
  const path = telemetrySuppressionFencePath(userDataPath);
  const existing = resolveTelemetrySuppressionFence({ userDataPath, nowMs });
  if (existing.kind === 'active') {
    throw new Error('An active telemetry suppression fence already exists');
  }
  const leaseId = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({
        schema: 1,
        reason,
        lease_id: leaseId,
        created_at_ms: nowMs,
        expires_at_ms: expiresAtMs,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    linkSync(temporaryPath, path);
    unlinkSync(temporaryPath);
  } catch (error) {
    removeRegularFile(temporaryPath);
    throw error;
  }
  return { path, leaseId };
}

export function clearTelemetrySuppressionFence({ userDataPath, leaseId }) {
  if (typeof leaseId !== 'string' || !LEASE_ID_RE.test(leaseId)) return false;
  const path = telemetrySuppressionFencePath(userDataPath);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_FENCE_BYTES) {
      return false;
    }
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.lease_id !== leaseId) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
