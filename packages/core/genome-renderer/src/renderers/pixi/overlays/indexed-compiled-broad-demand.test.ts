import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildCompiledBroadSurfaceManifestV2 } from '../overview/bounded-annotation-broad-surface';
import type { CompiledBroadSurfaceAdmissionProvenanceV1 } from '../overview/bounded-annotation-broad-surface';
import {
  COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
  compiledBroadDemandLeaseId,
} from './indexed-compiled-broad-lease';
import {
  getCompiledBroadSurfaceDemand,
  mintCompiledBroadSurfaceDemandLease,
  type CompiledBroadDemandHost,
  type CompiledBroadDemandPresenter,
  type CompiledBroadSurfaceDemandLeaseV1,
  type CompiledBroadSurfaceReadyDetailDemandV1,
} from './indexed-compiled-broad-demand';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function presenter(
  overrides: Partial<CompiledBroadDemandPresenter> = {}
): CompiledBroadDemandPresenter {
  return {
    reserveCorridorPresentationCapacity: () => true,
    reservePresentationCapacity: () => true,
    hasResidentCell: () => false,
    ...overrides,
  };
}

function host(overrides: Partial<CompiledBroadDemandHost> = {}): CompiledBroadDemandHost & {
  leases: CompiledBroadSurfaceDemandLeaseV1[];
  readyDetails: CompiledBroadSurfaceReadyDetailDemandV1[];
  forgotten: string[];
  planDerivations: number;
} {
  const leases: CompiledBroadSurfaceDemandLeaseV1[] = [];
  const readyDetails: CompiledBroadSurfaceReadyDetailDemandV1[] = [];
  const forgotten: string[] = [];
  const demand: CompiledBroadDemandHost & {
    leases: CompiledBroadSurfaceDemandLeaseV1[];
    readyDetails: CompiledBroadSurfaceReadyDetailDemandV1[];
    forgotten: string[];
    planDerivations: number;
  } = {
    cameraEpoch: 3,
    lastCamera: null,
    runtimePolicy: null,
    maxAnnotationLane: 11,
    candidateManifest: null,
    candidatePresenter: null,
    candidateProvenance: null,
    currentManifest: null,
    currentPresenter: null,
    currentProvenance: null,
    admissionOwner: () => null,
    provenanceIsCurrent: () => true,
    incrementPlanDerivationCount() {
      demand.planDerivations += 1;
    },
    viewportDetailForOwnerKey: () => undefined,
    rememberReadyDetailDemand(entry) {
      readyDetails.push(entry);
    },
    forgetReadyDetailDemand(fingerprint) {
      forgotten.push(fingerprint);
    },
    demandLease(leaseId) {
      return [...leases].reverse().find((lease) => lease.leaseId === leaseId);
    },
    storeDemandLease(lease) {
      leases.push(lease);
    },
    leases,
    readyDetails,
    forgotten,
    planDerivations: 0,
    ...overrides,
  };
  return demand;
}

describe('getCompiledBroadSurfaceDemand', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function getCompiledBroadSurfaceDemand(');
    expect(source).not.toContain('private mintCompiledBroadSurfaceDemandLease');
    expect(source).not.toContain('const earlyStatus = compiledBroadDemandEarlyStatus');
    expect(source).not.toContain('this.mintCompiledBroadSurfaceDemandLease');
  });

  it('exports the demand and lease-mint entry points for the overlay façade', () => {
    expect(typeof getCompiledBroadSurfaceDemand).toBe('function');
    expect(typeof mintCompiledBroadSurfaceDemandLease).toBe('function');
  });

  it('returns not-loaded before a manifest or presenter exists', () => {
    expect(getCompiledBroadSurfaceDemand(host()).status).toBe('not-loaded');
    expect(
      getCompiledBroadSurfaceDemand(
        host({
          currentManifest: { manifestFingerprint: 'm' } as never,
        })
      ).status
    ).toBe('not-loaded');
  });

  it('rejects a loaded owner whose provenance is not current, then asks for a camera', () => {
    const manifest = {
      manifestFingerprint: 'fp',
      artifactKey: 'art',
      trackId: 'mrna',
    } as never;
    const loaded = host({
      currentManifest: manifest,
      currentPresenter: presenter(),
      currentProvenance: { prepackedOwnerKey: 'owner' } as never,
      provenanceIsCurrent: () => false,
    });
    expect(getCompiledBroadSurfaceDemand(loaded)).toMatchObject({
      status: 'rejected',
      isoformMode: null,
      demandLeaseId: null,
    });
    loaded.provenanceIsCurrent = () => true;
    expect(getCompiledBroadSurfaceDemand(loaded)).toMatchObject({
      status: 'camera-required',
      isoformMode: 'canonical',
      laneLimit: 12,
    });
  });

  it('mints a lease for the current camera epoch and stores the allowed cells', () => {
    const demand = host({ cameraEpoch: 9 });
    const leaseId = mintCompiledBroadSurfaceDemandLease(demand, {
      manifestFingerprint: 'fp',
      isoformMode: 'canonical',
      laneLimit: 12,
      allowedCellIds: new Set(['a', 'b']),
    });
    expect(leaseId).toBe(
      compiledBroadDemandLeaseId({
        cameraEpoch: 9,
        manifestFingerprint: 'fp',
        isoformMode: 'canonical',
        laneLimit: 12,
      })
    );
    expect(demand.leases).toHaveLength(1);
    expect(demand.leases[0]).toMatchObject({
      contract: COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
      leaseId,
      cameraEpoch: 9,
      manifestFingerprint: 'fp',
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect([...demand.leases[0]!.allowedCellIds].sort()).toEqual(['a', 'b']);
    mintCompiledBroadSurfaceDemandLease(demand, {
      manifestFingerprint: 'fp',
      isoformMode: 'canonical',
      laneLimit: 12,
      allowedCellIds: new Set(['b', 'c']),
    });
    expect(demand.leases).toHaveLength(2);
    expect([...demand.leases[1]!.allowedCellIds].sort()).toEqual(['b', 'c']);
  });

  it('derives broad-ready demand, mints a lease, and lists missing required cells', async () => {
    const manifest = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v2:mrna',
      trackId: 'mrna',
      genomeLengthBp: 3_088_269_832,
      broadCorridorFinestSpanBp: 16_000_000,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 1,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 16,
      laneRowTransparentTailGutterPx: 2,
      laneRowCounts: { canonical: 12, expanded: 70 },
    });
    const residentCells = new Set<string>();
    const demand = host({
      currentManifest: manifest,
      currentPresenter: presenter({ hasResidentCell: (cellId) => residentCells.has(cellId) }),
      currentProvenance: { prepackedOwnerKey: 'mrna' } as CompiledBroadSurfaceAdmissionProvenanceV1,
      lastCamera: {
        viewportStartBp: 0,
        viewportEndBp: 500_000_000,
        viewportCssWidthPx: 800,
        devicePixelRatio: 1,
      },
    });
    const result = getCompiledBroadSurfaceDemand(demand, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect(result.status).toBe('broad-ready');
    expect(result.demandLeaseId).toBe(
      compiledBroadDemandLeaseId({
        cameraEpoch: 3,
        manifestFingerprint: manifest.manifestFingerprint,
        isoformMode: 'canonical',
        laneLimit: 12,
      })
    );
    expect(result.requiredCellAddresses.length).toBeGreaterThan(0);
    expect(result.missingRequiredCellAddresses).toEqual(result.requiredCellAddresses);
    expect(demand.leases).toHaveLength(1);
    expect(demand.planDerivations).toBe(1);
    expect(demand.leases[0]!.allowedCellIds.has(result.requiredCellAddresses[0]!.cellId)).toBe(
      true
    );
    for (const address of result.requiredCellAddresses) residentCells.add(address.cellId);
    const loaded = getCompiledBroadSurfaceDemand(demand, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect(loaded.requiredCellAddresses).toBe(result.requiredCellAddresses);
    expect(loaded.missingRequiredCellAddresses).toEqual([]);
    expect(demand.planDerivations).toBe(1);
    expect(demand.leases).toHaveLength(1);

    Object.assign(demand, {
      cameraEpoch: 4,
      lastCamera: {
        ...demand.lastCamera!,
        viewportStartBp: 1_000_000_000,
        viewportEndBp: 1_500_000_000,
      },
    });
    const moved = getCompiledBroadSurfaceDemand(demand, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect(moved.requiredCellAddresses).not.toEqual(result.requiredCellAddresses);
    expect(moved.demandLeaseId).not.toBe(result.demandLeaseId);
    expect(demand.planDerivations).toBe(2);

    const reduced = getCompiledBroadSurfaceDemand(demand, {
      isoformMode: 'canonical',
      laneLimit: 2,
    });
    expect(reduced.requiredCellAddresses.length).toBeLessThan(moved.requiredCellAddresses.length);
    expect(reduced.demandLeaseId).not.toBe(moved.demandLeaseId);
    expect(demand.planDerivations).toBe(3);
  });

  it('keeps broad demand independent of a retained detail corridor', async () => {
    const manifest = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v2:mrna',
      trackId: 'mrna',
      genomeLengthBp: 3_088_269_832,
      broadCorridorFinestSpanBp: 16_000_000,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 1,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 16,
      laneRowTransparentTailGutterPx: 2,
      laneRowCounts: { canonical: 12, expanded: 70 },
    });
    const detailLookup = vi.fn(
      () =>
        ({
          coverageStartBp: -100,
          coverageEndBp: -1,
          handoffStartBp: -100,
          handoffEndBp: -1,
        }) as never
    );
    const demand = host({
      currentManifest: manifest,
      currentPresenter: presenter(),
      currentProvenance: { prepackedOwnerKey: 'mrna' } as CompiledBroadSurfaceAdmissionProvenanceV1,
      lastCamera: {
        viewportStartBp: 0,
        viewportEndBp: 500_000_000,
        viewportCssWidthPx: 800,
        devicePixelRatio: 1,
      },
      viewportDetailForOwnerKey: detailLookup,
    });

    const result = getCompiledBroadSurfaceDemand(demand, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });

    expect(result.status).toBe('broad-ready');
    expect(result.requiredCellAddresses.length).toBeGreaterThan(0);
    expect(detailLookup).not.toHaveBeenCalled();
  });

  it('keeps detail-required demand on the return bridge and forgets an incomplete ready-detail lease', async () => {
    const manifest = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v2:small-mrna',
      trackId: 'mrna',
      genomeLengthBp: 12_157_105,
      broadCorridorFinestSpanBp: 6_000_000,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 1,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 16,
      laneRowTransparentTailGutterPx: 2,
      laneRowCounts: { canonical: 12, expanded: 70 },
    });
    const demand = host({
      currentManifest: manifest,
      currentPresenter: presenter(),
      currentProvenance: { prepackedOwnerKey: 'mrna' } as CompiledBroadSurfaceAdmissionProvenanceV1,
      lastCamera: {
        viewportStartBp: 0,
        viewportEndBp: 12_157_105,
        viewportCssWidthPx: 1_600,
        devicePixelRatio: 1,
      },
    });
    const result = getCompiledBroadSurfaceDemand(demand, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect(result.status).toBe('detail-required');
    expect(result.requiredCellAddresses).toEqual([]);
    expect(result.demandLeaseId).not.toBeNull();
    expect(demand.leases).toHaveLength(1);
    expect(demand.readyDetails).toEqual([]);
    expect(demand.forgotten).toEqual([manifest.manifestFingerprint]);
  });
});
