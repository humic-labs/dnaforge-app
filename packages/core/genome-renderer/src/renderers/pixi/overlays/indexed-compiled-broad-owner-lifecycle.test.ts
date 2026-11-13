import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1 } from './indexed-compiled-broad-lease';
import type { CompiledBroadSurfaceDemandLeaseV1 } from './indexed-compiled-broad-demand';
import {
  clearCompiledBroadSurfaceManifest,
  compiledBroadSurfaceAdmissionOwner,
  destroyCompiledBroadSurfaceOwnedTextures,
  disposeCompiledBroadSurfaceCandidate,
  reconcileCompiledBroadSurfaceResidentLeases,
  type CompiledBroadOwnerLifecycleHost,
  type CompiledBroadOwnerLifecycleOwner,
  type CompiledBroadOwnerLifecyclePresenter,
} from './indexed-compiled-broad-owner-lifecycle';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';

function overlayDir(): string {
  const metaUrl = import.meta.url;
  return metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
}

function overlaySource(): string {
  return readFileSync(join(overlayDir(), 'annotation-overlay.ts'), 'utf8');
}

function controllerSource(): string {
  return readFileSync(join(overlayDir(), 'indexed-compiled-broad-surface-controller.ts'), 'utf8');
}

function texture(): { destroyed: boolean; destroy(destroyBaseTexture: true): void } {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
}

function container(): {
  parent: unknown;
  children: unknown[];
  removeChild(child: unknown): unknown;
} {
  const next = {
    parent: null as unknown,
    children: [] as unknown[],
    removeChild(child: unknown) {
      next.children = next.children.filter((item) => item !== child);
      if (child && typeof child === 'object' && 'parent' in child) {
        (child as { parent: unknown }).parent = null;
      }
      return child;
    },
  };
  return next;
}

function presenter(
  cellIds: string[] = [],
  activeCellIds: string[] = []
): CompiledBroadOwnerLifecyclePresenter & {
  destroyed: boolean;
  resident: Set<string>;
} {
  const resident = new Set(cellIds);
  const active = [...activeCellIds];
  const view = container();
  const next = {
    container: view,
    destroyed: false,
    resident,
    get residentCellCount() {
      return resident.size;
    },
    activeResidentCellIds: () => [...active],
    evictCellsExcept(requestedCellIds: ReadonlySet<string>) {
      const evicted: string[] = [];
      for (const cellId of [...resident]) {
        if (requestedCellIds.has(cellId)) continue;
        resident.delete(cellId);
        evicted.push(cellId);
      }
      return evicted;
    },
    destroy() {
      next.destroyed = true;
    },
  };
  return next as unknown as CompiledBroadOwnerLifecyclePresenter & {
    destroyed: boolean;
    resident: Set<string>;
  };
}

function manifest(fingerprint: string, trackId = 'mRNA'): CompiledBroadSurfaceManifestV2 {
  return { manifestFingerprint: fingerprint, trackId } as CompiledBroadSurfaceManifestV2;
}

function provenance(fingerprint: string): CompiledBroadSurfaceAdmissionProvenanceV1 {
  return { manifestFingerprint: fingerprint } as CompiledBroadSurfaceAdmissionProvenanceV1;
}

function lease(
  overrides: Partial<CompiledBroadSurfaceDemandLeaseV1> & { leaseId: string }
): CompiledBroadSurfaceDemandLeaseV1 {
  return {
    contract: COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1,
    cameraEpoch: 3,
    manifestFingerprint: 'mf-active',
    isoformMode: 'canonical',
    laneLimit: 12,
    allowedCellIds: new Set(['keep-a', 'keep-b']),
    ...overrides,
  };
}

function owner(
  fingerprint: string,
  trackId: string,
  cellIds: string[] = []
): CompiledBroadOwnerLifecycleOwner {
  return {
    manifest: manifest(fingerprint, trackId),
    provenance: provenance(fingerprint),
    presenter: presenter(cellIds),
  };
}

function host(
  overrides: Partial<CompiledBroadOwnerLifecycleHost> = {}
): CompiledBroadOwnerLifecycleHost & {
  laneReconciles: number;
} {
  const overlayContainer = container();
  const next: CompiledBroadOwnerLifecycleHost & { laneReconciles: number } = {
    container: overlayContainer as never,
    compiledBroadSurfaceReadyDetailDemands: new Map(),
    compiledBroadSurfaceCandidateManifest: null,
    compiledBroadSurfaceCandidateProvenance: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceManifest: null,
    compiledBroadSurfaceProvenance: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceTrackOwners: new Map(),
    compiledBroadSurfaceTrackCandidateOwners: new Map(),
    compiledBroadSurfaceDemandLeases: new Map(),
    compiledBroadSurfacePlanStatus: 'broad-presenting',
    compiledBroadSurfaceLastCompleteTrackIds: Object.freeze(['mRNA']),
    compiledBroadSurfaceOwnedLastFrame: true,
    compiledBroadSurfaceOwnedCellTextures: new Map(),
    compiledBroadSurfaceGpuPreuploadedCellIds: new Set(),
    compiledBroadSurfaceLastCameraRequest: { viewportStartBp: 0 },
    compiledBroadSurfaceLastPresentationCamera: { viewportStartBp: 0 },
    compiledBroadSurfaceCameraEpoch: 3,
    prepackedAnnotationSceneResidents: { size: 0 },
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationRuntimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
    compiledBroadSurfaceProvenanceIsCurrent: (loaded, current) =>
      Boolean(loaded && current && loaded.manifestFingerprint === current.manifestFingerprint),
    compiledBroadSurfaceOwnerForTrack: (trackId) =>
      next.compiledBroadSurfaceTrackOwners.get(trackId) ??
      (next.compiledBroadSurfaceManifest?.trackId === trackId ? { present: true } : null),
    reconcileAnnotationLaneEnvelopeAuthority() {
      next.laneReconciles += 1;
    },
    laneReconciles: 0,
    ...overrides,
  };
  return next;
}

describe('compiled-broad owner lifecycle presenter', () => {
  it('keeps clear, reconcile, admission owner, and dispose out of the overlay class', () => {
    const overlay = overlaySource();
    const controller = controllerSource();
    expect(controller).toContain('clearCompiledBroadSurfaceManifestFn(');
    expect(controller).toContain('reconcileCompiledBroadSurfaceResidentLeasesFn(');
    expect(controller).toContain('compiledBroadSurfaceAdmissionOwnerFn(');
    expect(controller).toContain('disposeCompiledBroadSurfaceCandidateFn(');
    expect(controller).toContain('disposeCompiledBroadSurfaceTrackOwnerFn(');
    expect(controller).toContain('destroyCompiledBroadSurfaceOwnedTexturesFn(');
    expect(overlay).not.toContain('inspectCompiledBroadDemandLeaseReconcileRequest(');
    expect(overlay).not.toContain('presenter.evictCellsExcept(');
    expect(overlay).not.toContain('The committed bank is always retained');
    expect(overlay).not.toContain('ownershipKey.startsWith(prefix)');
  });

  it('prefers a current-provenance candidate owner over the active singleton', () => {
    const candidate = owner('mf-cand', 'lnc_RNA');
    const lifecycle = host({
      compiledBroadSurfaceTrackCandidateOwners: new Map([['lnc_RNA', candidate]]),
      compiledBroadSurfaceManifest: manifest('mf-cand'),
      compiledBroadSurfaceProvenance: provenance('mf-cand'),
      compiledBroadSurfacePresenter: presenter(),
    });
    expect(compiledBroadSurfaceAdmissionOwner(lifecycle, 'mf-cand')).toBe(candidate);
  });

  it('skips stale provenance and falls back to the current singleton', () => {
    const stale = owner('mf-stale', 'lnc_RNA');
    const current = presenter();
    const lifecycle = host({
      compiledBroadSurfaceTrackOwners: new Map([['lnc_RNA', stale]]),
      compiledBroadSurfaceManifest: manifest('mf-active'),
      compiledBroadSurfaceProvenance: provenance('mf-active'),
      compiledBroadSurfacePresenter: current,
      compiledBroadSurfaceProvenanceIsCurrent: (loaded, currentProvenance) =>
        loaded?.manifestFingerprint === 'mf-active' &&
        currentProvenance?.manifestFingerprint === 'mf-active',
    });
    expect(compiledBroadSurfaceAdmissionOwner(lifecycle, 'mf-stale')).toBeNull();
    expect(compiledBroadSurfaceAdmissionOwner(lifecycle, 'mf-active')).toMatchObject({
      manifest: { manifestFingerprint: 'mf-active' },
      presenter: current,
    });
  });

  it('rejects an empty or stale lease list before any eviction', () => {
    const current = presenter(['keep-a', 'drop-me']);
    const lifecycle = host({
      compiledBroadSurfaceManifest: manifest('mf-active'),
      compiledBroadSurfacePresenter: current,
    });
    expect(reconcileCompiledBroadSurfaceResidentLeases(lifecycle, [])).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-live-demand-lease-required',
      evictedCellIds: [],
    });
    expect([...current.resident]).toEqual(['keep-a', 'drop-me']);
    expect(reconcileCompiledBroadSurfaceResidentLeases(lifecycle, ['missing'])).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-demand-lease-stale-or-unknown',
    });
  });

  it('evicts cells outside the committed bank plus requested leases and drops unused leases', () => {
    const current = presenter(['committed', 'warm', 'drop-me'], ['committed']);
    const dropTexture = texture();
    const keepTexture = texture();
    const lifecycle = host({
      compiledBroadSurfaceManifest: manifest('mf-active'),
      compiledBroadSurfacePresenter: current,
      compiledBroadSurfaceOwnedCellTextures: new Map([
        ['mf-active\u0000drop-me', dropTexture as never],
        ['mf-active\u0000committed', keepTexture as never],
      ]),
      compiledBroadSurfaceGpuPreuploadedCellIds: new Set([
        'mf-active\u0000drop-me',
        'mf-active\u0000committed',
      ]),
      compiledBroadSurfaceReadyDetailDemands: new Map([['mf-active', { ready: true }]]),
      compiledBroadSurfaceDemandLeases: new Map([
        [
          'keep',
          lease({
            leaseId: 'keep',
            allowedCellIds: new Set(['warm']),
          }),
        ],
        [
          'unused',
          lease({
            leaseId: 'unused',
            allowedCellIds: new Set(['drop-me']),
          }),
        ],
      ]),
    });
    expect(reconcileCompiledBroadSurfaceResidentLeases(lifecycle, ['keep'])).toEqual({
      status: 'reconciled',
      cameraEpoch: 3,
      retainedCellCount: 2,
      evictedCellIds: ['drop-me'],
    });
    expect([...current.resident]).toEqual(['committed', 'warm']);
    expect(dropTexture.destroyed).toBe(true);
    expect(keepTexture.destroyed).toBe(false);
    expect(lifecycle.compiledBroadSurfaceOwnedCellTextures.has('mf-active\u0000drop-me')).toBe(
      false
    );
    expect(lifecycle.compiledBroadSurfaceReadyDetailDemands.size).toBe(0);
    expect([...lifecycle.compiledBroadSurfaceDemandLeases.keys()]).toEqual(['keep']);
  });

  it('destroys only the matching fingerprint textures and candidate presenter', () => {
    const candidate = presenter(['cand']);
    (candidate.container as { parent: unknown }).parent = 'overlay';
    const other = texture();
    const matching = texture();
    const overlayContainer = container();
    overlayContainer.children.push(candidate.container);
    const lifecycle = host({
      container: overlayContainer as never,
      compiledBroadSurfaceCandidateManifest: manifest('mf-cand'),
      compiledBroadSurfaceCandidateProvenance: provenance('mf-cand'),
      compiledBroadSurfaceCandidatePresenter: candidate,
      compiledBroadSurfaceOwnedCellTextures: new Map([
        ['mf-cand\u0000cell', matching as never],
        ['mf-other\u0000cell', other as never],
      ]),
      compiledBroadSurfaceGpuPreuploadedCellIds: new Set([
        'mf-cand\u0000cell',
        'mf-other\u0000cell',
      ]),
    });
    destroyCompiledBroadSurfaceOwnedTextures(lifecycle, 'mf-cand');
    expect(matching.destroyed).toBe(true);
    expect(other.destroyed).toBe(false);
    disposeCompiledBroadSurfaceCandidate(lifecycle);
    expect(candidate.destroyed).toBe(true);
    expect(lifecycle.compiledBroadSurfaceCandidatePresenter).toBeNull();
  });

  it('clears one fingerprint without bumping the camera epoch', () => {
    const current = presenter(['cell']);
    (current.container as { parent: unknown }).parent = 'overlay';
    const overlayContainer = container();
    overlayContainer.children.push(current.container);
    const leftover = owner('mf-keep', 'lnc_RNA', ['keep']);
    const lifecycle = host({
      container: overlayContainer as never,
      compiledBroadSurfaceManifest: manifest('mf-active'),
      compiledBroadSurfaceProvenance: provenance('mf-active'),
      compiledBroadSurfacePresenter: current,
      compiledBroadSurfaceTrackOwners: new Map([['lnc_RNA', leftover]]),
      compiledBroadSurfaceDemandLeases: new Map([
        ['gone', lease({ leaseId: 'gone', manifestFingerprint: 'mf-active' })],
        ['keep', lease({ leaseId: 'keep', manifestFingerprint: 'mf-keep' })],
      ]),
      compiledBroadSurfaceLastCompleteTrackIds: Object.freeze(['mRNA', 'lnc_RNA']),
    });
    clearCompiledBroadSurfaceManifest(lifecycle, 'mf-active');
    expect(current.destroyed).toBe(true);
    expect(lifecycle.compiledBroadSurfacePresenter).toBeNull();
    expect(lifecycle.compiledBroadSurfaceTrackOwners.has('lnc_RNA')).toBe(true);
    expect(lifecycle.compiledBroadSurfaceDemandLeases.has('keep')).toBe(true);
    expect(lifecycle.compiledBroadSurfaceDemandLeases.has('gone')).toBe(false);
    expect(lifecycle.compiledBroadSurfaceCameraEpoch).toBe(3);
    expect(lifecycle.compiledBroadSurfacePlanStatus).toBe('broad-cells-missing');
    expect(lifecycle.compiledBroadSurfaceLastCompleteTrackIds).toEqual(['lnc_RNA']);
    expect(lifecycle.laneReconciles).toBe(0);
  });

  it('full clear destroys every owner, bumps the camera epoch, and drops the runtime policy', () => {
    const current = presenter(['cell']);
    const candidate = presenter(['cand']);
    const extra = owner('mf-extra', 'lnc_RNA', ['extra']);
    const leftover = texture();
    const lifecycle = host({
      compiledBroadSurfaceManifest: manifest('mf-active'),
      compiledBroadSurfaceProvenance: provenance('mf-active'),
      compiledBroadSurfacePresenter: current,
      compiledBroadSurfaceCandidateManifest: manifest('mf-cand'),
      compiledBroadSurfaceCandidateProvenance: provenance('mf-cand'),
      compiledBroadSurfaceCandidatePresenter: candidate,
      compiledBroadSurfaceTrackOwners: new Map([['lnc_RNA', extra]]),
      compiledBroadSurfaceOwnedCellTextures: new Map([['mf-active\u0000cell', leftover as never]]),
      compiledBroadSurfaceDemandLeases: new Map([['keep', lease({ leaseId: 'keep' })]]),
    });
    clearCompiledBroadSurfaceManifest(lifecycle);
    expect(current.destroyed).toBe(true);
    expect(candidate.destroyed).toBe(true);
    expect(extra.presenter).toMatchObject({ destroyed: true });
    expect(leftover.destroyed).toBe(true);
    expect(lifecycle.compiledBroadSurfaceTrackOwners.size).toBe(0);
    expect(lifecycle.compiledBroadSurfaceDemandLeases.size).toBe(0);
    expect(lifecycle.compiledBroadSurfaceCameraEpoch).toBe(4);
    expect(lifecycle.compiledBroadSurfacePlanStatus).toBe('not-loaded');
    expect(lifecycle.compiledBroadSurfaceLastCameraRequest).toBeNull();
    expect(lifecycle.prepackedAnnotationRuntimePolicy).toBeNull();
    expect(lifecycle.laneReconciles).toBe(1);
  });
});
