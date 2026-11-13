import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
  compiledBroadDemandLeaseId,
  compiledBroadSurfaceAdmissionLeaseFailure,
} from './indexed-compiled-broad-lease';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('compiled-broad demand lease identity', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function compiledBroadDemandLeaseId');
    expect(source).not.toContain('function compiledBroadSurfaceAdmissionLeaseFailure');
  });

  it('names a lease by epoch, fingerprint, isoform, and lane cap', () => {
    expect(
      compiledBroadDemandLeaseId({
        cameraEpoch: 4,
        manifestFingerprint: 'mf',
        isoformMode: 'canonical',
        laneLimit: 12,
      })
    ).toBe(`${COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1}:4:mf:canonical:12`);
  });

  it('rejects a missing, stale, mismatched, or out-of-lease cell before GPU admit', () => {
    const lease = {
      cameraEpoch: 4,
      manifestFingerprint: 'mf',
      allowedCellIds: new Set(['cell-a']),
    };
    expect(
      compiledBroadSurfaceAdmissionLeaseFailure({
        demandLeaseId: undefined,
        cameraEpoch: 4,
        manifestFingerprint: 'mf',
        cellId: 'cell-a',
        lease,
      })
    ).toBe('compiled-broad-surface-demand-lease-required');
    expect(
      compiledBroadSurfaceAdmissionLeaseFailure({
        demandLeaseId: 'lease',
        cameraEpoch: 5,
        manifestFingerprint: 'mf',
        cellId: 'cell-a',
        lease,
      })
    ).toBe('compiled-broad-surface-demand-lease-stale-or-unknown');
    expect(
      compiledBroadSurfaceAdmissionLeaseFailure({
        demandLeaseId: 'lease',
        cameraEpoch: 4,
        manifestFingerprint: 'other',
        cellId: 'cell-a',
        lease,
      })
    ).toBe('compiled-broad-surface-demand-lease-manifest-mismatch');
    expect(
      compiledBroadSurfaceAdmissionLeaseFailure({
        demandLeaseId: 'lease',
        cameraEpoch: 4,
        manifestFingerprint: 'mf',
        cellId: 'cell-b',
        lease,
      })
    ).toBe('compiled-broad-surface-cell-outside-demand-lease');
    expect(
      compiledBroadSurfaceAdmissionLeaseFailure({
        demandLeaseId: 'lease',
        cameraEpoch: 4,
        manifestFingerprint: 'mf',
        cellId: 'cell-a',
        lease,
      })
    ).toBeNull();
  });
});
