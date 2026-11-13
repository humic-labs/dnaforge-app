import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectCompiledBroadDemandLeaseReconcileRequest } from './indexed-compiled-broad-lease-reconcile';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('inspectCompiledBroadDemandLeaseReconcileRequest', () => {
  it('lives outside annotation-overlay.ts', () => {
    expect(overlaySource()).not.toContain(
      'function inspectCompiledBroadDemandLeaseReconcileRequest'
    );
  });

  it('rejects an empty, oversized, or duplicate lease list before any eviction', () => {
    const leasesById = new Map();
    expect(
      inspectCompiledBroadDemandLeaseReconcileRequest({
        demandLeaseIds: [],
        currentCameraEpoch: 1,
        leasesById,
        ownerFingerprints: new Set(['m1']),
      })
    ).toEqual({ ok: false, reason: 'compiled-broad-surface-live-demand-lease-required' });
    expect(
      inspectCompiledBroadDemandLeaseReconcileRequest({
        demandLeaseIds: Array.from({ length: 17 }, (_, i) => `lease-${i}`),
        currentCameraEpoch: 1,
        leasesById,
        ownerFingerprints: new Set(['m1']),
      })
    ).toEqual({ ok: false, reason: 'compiled-broad-surface-live-demand-lease-limit-exceeded' });
    expect(
      inspectCompiledBroadDemandLeaseReconcileRequest({
        demandLeaseIds: ['a', 'a'],
        currentCameraEpoch: 1,
        leasesById,
        ownerFingerprints: new Set(['m1']),
      })
    ).toEqual({ ok: false, reason: 'compiled-broad-surface-duplicate-demand-lease' });
  });

  it('rejects a stale lease or a lease whose owner is not loaded', () => {
    const leasesById = new Map([
      ['fresh', { cameraEpoch: 3, manifestFingerprint: 'm1' }],
      ['stale', { cameraEpoch: 2, manifestFingerprint: 'm1' }],
      ['orphan', { cameraEpoch: 3, manifestFingerprint: 'missing' }],
    ]);
    expect(
      inspectCompiledBroadDemandLeaseReconcileRequest({
        demandLeaseIds: ['stale'],
        currentCameraEpoch: 3,
        leasesById,
        ownerFingerprints: new Set(['m1']),
      })
    ).toEqual({ ok: false, reason: 'compiled-broad-surface-demand-lease-stale-or-unknown' });
    expect(
      inspectCompiledBroadDemandLeaseReconcileRequest({
        demandLeaseIds: ['orphan'],
        currentCameraEpoch: 3,
        leasesById,
        ownerFingerprints: new Set(['m1']),
      })
    ).toEqual({ ok: false, reason: 'compiled-broad-surface-demand-lease-owner-not-loaded' });
  });

  it('returns the unique current-epoch leases when every owner is loaded', () => {
    const fresh = { cameraEpoch: 3, manifestFingerprint: 'm1' };
    const result = inspectCompiledBroadDemandLeaseReconcileRequest({
      demandLeaseIds: ['fresh'],
      currentCameraEpoch: 3,
      leasesById: new Map([['fresh', fresh]]),
      ownerFingerprints: new Set(['m1']),
    });
    expect(result).toEqual({
      ok: true,
      requestedLeaseIds: new Set(['fresh']),
      leases: [fresh],
    });
  });
});
