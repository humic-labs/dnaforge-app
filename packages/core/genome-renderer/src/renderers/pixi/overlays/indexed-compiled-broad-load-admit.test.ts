import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RendererType } from 'pixi.js';
import {
  buildCompiledBroadSurfaceManifestV2,
  compiledBroadSurfaceCellIdV2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import {
  loadCompiledBroadSurfaceManifest,
  type CompiledBroadLoadHost,
} from './indexed-compiled-broad-load';
import {
  admitCompiledBroadSurfaceCellTexture,
  admitCompiledBroadSurfaceRgbaCell,
  admitCompiledBroadSurfaceTransparentCell,
  type CompiledBroadAdmitHost,
} from './indexed-compiled-broad-admit';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function provenance(
  overrides: Partial<CompiledBroadSurfaceAdmissionProvenanceV1> = {}
): CompiledBroadSurfaceAdmissionProvenanceV1 {
  return {
    genomeIdentity: 'hg002',
    genomeLengthBp: 1000,
    sourceFingerprint: '0123456789abcdef01234567',
    placementFingerprint: 'ap1:0123456789abcdef01234567',
    prepackedOwnerKey: 'mrna',
    prepackedArtifactKey: 'art',
    themeMode: 'light',
    ...overrides,
  } as CompiledBroadSurfaceAdmissionProvenanceV1;
}

function loadHost(
  overrides: Partial<CompiledBroadLoadHost> & {
    installedActive?: CompiledBroadSurfaceTrackOwnerV2[];
    installedCandidates?: CompiledBroadSurfaceTrackOwnerV2[];
    disposed?: CompiledBroadSurfaceTrackOwnerV2[];
    statuses?: string[];
    containers?: unknown[];
  } = {}
): CompiledBroadLoadHost & {
  installedActive: CompiledBroadSurfaceTrackOwnerV2[];
  installedCandidates: CompiledBroadSurfaceTrackOwnerV2[];
  disposed: CompiledBroadSurfaceTrackOwnerV2[];
  statuses: string[];
  containers: unknown[];
  reconciled: number;
} {
  const installedActive = overrides.installedActive ?? [];
  const installedCandidates = overrides.installedCandidates ?? [];
  const disposed = overrides.disposed ?? [];
  const statuses = overrides.statuses ?? [];
  const containers = overrides.containers ?? [];
  const host: CompiledBroadLoadHost & {
    installedActive: CompiledBroadSurfaceTrackOwnerV2[];
    installedCandidates: CompiledBroadSurfaceTrackOwnerV2[];
    disposed: CompiledBroadSurfaceTrackOwnerV2[];
    statuses: string[];
    containers: unknown[];
    reconciled: number;
  } = {
    genomeLength: 1000,
    requirement: null,
    hasAdmittedSurface: false,
    provenanceFailure: () => null,
    requireCompiledBroadSurface: () => true,
    ownerForTrack: () => null,
    candidateOwnerForTrack: () => null,
    provenanceIsCurrent: () => true,
    admissionIdentityMatches: () => true,
    disposeRegisteredCandidate(owner) {
      disposed.push(owner);
    },
    installActiveOwner(owner) {
      installedActive.push(owner);
    },
    installCandidateOwner(owner) {
      installedCandidates.push(owner);
    },
    reconcileLaneEnvelope() {
      host.reconciled += 1;
    },
    setPlanStatus(status) {
      statuses.push(status);
    },
    addPresenterContainer(container) {
      containers.push(container);
    },
    installedActive,
    installedCandidates,
    disposed,
    statuses,
    containers,
    reconciled: 0,
    ...overrides,
  };
  return host;
}

function admitHost(overrides: Partial<CompiledBroadAdmitHost> = {}): CompiledBroadAdmitHost & {
  preuploadFailures: number;
  preuploads: Array<{
    explicitCopyByteLength: number;
    uploadByteLength: number;
    presenterWasVisible: boolean;
  }>;
  rgbaAdmissions: number;
} {
  const gpuPreuploadedCellIds = overrides.gpuPreuploadedCellIds ?? new Set<string>();
  const ownedCellTextures = overrides.ownedCellTextures ?? new Map();
  const host: CompiledBroadAdmitHost & {
    preuploadFailures: number;
    preuploads: Array<{
      explicitCopyByteLength: number;
      uploadByteLength: number;
      presenterWasVisible: boolean;
    }>;
    rgbaAdmissions: number;
  } = {
    admissionOwner: () => null,
    admissionLeaseFailure: () => null,
    pixiRenderer: null,
    gpuPreuploadedCellIds,
    ownedCellTextures,
    noteGpuPreuploadFailure() {
      host.preuploadFailures += 1;
    },
    noteGpuPreupload(explicitCopyByteLength, uploadByteLength, presenterWasVisible) {
      host.preuploads.push({ explicitCopyByteLength, uploadByteLength, presenterWasVisible });
    },
    noteRgbaAdmission() {
      host.rgbaAdmissions += 1;
    },
    preuploadFailures: 0,
    preuploads: [],
    rgbaAdmissions: 0,
    ...overrides,
  };
  return host;
}

describe('compiled-broad load/admit presenter', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function loadCompiledBroadSurfaceManifest(');
    expect(source).not.toContain('function admitCompiledBroadSurfaceCellTexture(');
    expect(source).not.toContain('function admitCompiledBroadSurfaceTransparentCell(');
    expect(source).not.toContain('function admitCompiledBroadSurfaceRgbaCell(');
    expect(source).not.toContain('const currentRequirement = this.compiledBroadSurfaceRequirement');
    expect(source).not.toContain('createCompiledBroadSurfaceRgbaTextureV2({');
    expect(source).not.toContain('compiled-broad-surface-rgba-physical-geometry-mismatch');
    expect(source).not.toContain('compiled-broad-surface-gpu-preupload-renderer-unavailable');
  });

  it('exports the load and admit entry points for the overlay façade', () => {
    expect(typeof loadCompiledBroadSurfaceManifest).toBe('function');
    expect(typeof admitCompiledBroadSurfaceCellTexture).toBe('function');
    expect(typeof admitCompiledBroadSurfaceTransparentCell).toBe('function');
    expect(typeof admitCompiledBroadSurfaceRgbaCell).toBe('function');
  });

  it('rejects a length-mismatched or failed-provenance manifest without installing', () => {
    const host = loadHost();
    const mismatched = {
      genomeLengthBp: 9,
      broadCorridorFinestSpanBp: 100,
      trackId: 'mRNA',
      manifestFingerprint: 'fp',
    } as CompiledBroadSurfaceManifestV2;
    expect(loadCompiledBroadSurfaceManifest(host, mismatched, provenance())).toBe(false);
    expect(host.installedActive).toEqual([]);
    expect(host.reconciled).toBe(0);

    const failed = loadHost({
      provenanceFailure: () => 'compiled-broad-surface-provenance-identity-mismatch',
    });
    expect(
      loadCompiledBroadSurfaceManifest(
        failed,
        { ...mismatched, genomeLengthBp: 1000 },
        provenance()
      )
    ).toBe(false);
    expect(failed.installedActive).toEqual([]);
  });

  it('reuses the current owner and rebinds only when identity changes', () => {
    const presenter = {
      container: { id: 'keep' },
    } as unknown as CompiledBroadSurfaceTrackOwnerV2['presenter'];
    const owner = {
      manifest: { manifestFingerprint: 'fp', trackId: 'mRNA' },
      provenance: provenance(),
      presenter,
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const candidate = {
      manifest: { manifestFingerprint: 'other' },
      provenance: provenance(),
      presenter: { container: { id: 'drop' } },
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const reused = loadHost({
      ownerForTrack: () => owner,
      candidateOwnerForTrack: () => candidate,
    });
    const next = {
      genomeLengthBp: 1000,
      broadCorridorFinestSpanBp: 100,
      trackId: 'mRNA',
      manifestFingerprint: 'fp',
    } as CompiledBroadSurfaceManifestV2;
    expect(loadCompiledBroadSurfaceManifest(reused, next, provenance())).toBe(true);
    expect(reused.disposed).toEqual([candidate]);
    expect(reused.installedActive).toEqual([]);
    expect(reused.reconciled).toBe(1);

    const rebound = loadHost({
      ownerForTrack: () => owner,
      candidateOwnerForTrack: () => candidate,
      admissionIdentityMatches: () => false,
    });
    expect(
      loadCompiledBroadSurfaceManifest(rebound, next, provenance({ prepackedOwnerKey: 'v2' }))
    ).toBe(true);
    expect(rebound.disposed).toEqual([candidate, candidate]);
    expect(rebound.installedActive).toHaveLength(1);
    expect(rebound.installedActive[0]?.presenter).toBe(presenter);
    expect(rebound.installedActive[0]?.provenance.prepackedOwnerKey).toBe('v2');
  });

  it('marks a constructor failure as rejected and does not install', () => {
    const host = loadHost();
    expect(
      loadCompiledBroadSurfaceManifest(
        host,
        {
          genomeLengthBp: 1000,
          broadCorridorFinestSpanBp: 100,
          trackId: 'mRNA',
          manifestFingerprint: 'fp',
        } as CompiledBroadSurfaceManifestV2,
        provenance()
      )
    ).toBe(false);
    expect(host.statuses).toEqual(['rejected']);
    expect(host.installedActive).toEqual([]);
    expect(host.installedCandidates).toEqual([]);
  });

  it('rejects cell and rgba admission when no current owner is loaded', () => {
    const host = admitHost();
    expect(
      admitCompiledBroadSurfaceCellTexture(host, {
        demandLeaseId: 'lease',
        manifestFingerprint: 'fp',
        isoformMode: 'canonical',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
        texture: {} as never,
      })
    ).toEqual({
      status: 'rejected',
      cellId: null,
      reason: 'compiled-broad-surface-manifest-not-loaded',
    });
    expect(
      admitCompiledBroadSurfaceTransparentCell(host, {
        demandLeaseId: 'lease',
        manifestFingerprint: 'fp',
        cellId: 'cell',
        isoformMode: 'canonical',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-manifest-not-loaded',
    });
    expect(
      admitCompiledBroadSurfaceRgbaCell(host, {
        demandLeaseId: 'lease',
        manifestFingerprint: 'fp',
        cellId: 'cell',
        isoformMode: 'canonical',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
        widthPx: 1,
        heightPx: 1,
        premultipliedRgba: new Uint8Array(4),
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-manifest-not-loaded',
    });
  });

  it('admits a transparent cell and refuses a renderer-less rgba cell', async () => {
    const manifest = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v2:admit',
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
    const cellId = compiledBroadSurfaceCellIdV2({
      manifest,
      isoformMode: 'canonical',
      level: 0,
      tileX: 0,
      laneSlabIndex: 0,
    });
    const owner = {
      manifest,
      provenance: provenance(),
      presenter: {
        isPresenting: false,
        hasResidentCell: () => false,
        admitTransparentCell: () => ({ status: 'admitted' as const, cellId }),
        admitCellTexture: () => ({ status: 'admitted' as const, cellId }),
      },
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const host = admitHost({
      admissionOwner: () => owner,
      pixiRenderer: { type: RendererType.WEBGL } as never,
    });
    expect(
      admitCompiledBroadSurfaceTransparentCell(host, {
        demandLeaseId: 'lease',
        manifestFingerprint: manifest.manifestFingerprint,
        cellId,
        isoformMode: 'canonical',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
      })
    ).toMatchObject({
      status: 'admitted',
      cellId,
      gpuPreuploaded: true,
    });
    expect(
      admitCompiledBroadSurfaceRgbaCell(host, {
        demandLeaseId: 'lease',
        manifestFingerprint: manifest.manifestFingerprint,
        cellId,
        isoformMode: 'canonical',
        level: 0,
        tileX: 0,
        laneSlabIndex: 0,
        widthPx: manifest.broadTilePhysicalWidthPx + manifest.broadTileXGuardPhysicalPx * 2,
        heightPx: manifest.laneSlabRowCount * manifest.laneRowTextureStridePx,
        premultipliedRgba: new Uint8Array(
          (manifest.broadTilePhysicalWidthPx + manifest.broadTileXGuardPhysicalPx * 2) *
            manifest.laneSlabRowCount *
            manifest.laneRowTextureStridePx *
            4
        ),
      })
    ).toMatchObject({
      status: 'rejected',
      cellId,
      reason: 'compiled-broad-surface-gpu-preupload-renderer-unavailable',
    });
  });
});
