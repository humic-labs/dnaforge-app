import { describe, expect, it } from 'vitest';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import {
  annotationTrackRealizedLaneCapacity,
  annotationTrackStackMaxLane,
  compiledBroadSurfaceLaneStart,
  compiledBroadSurfaceRosterLaneStarts,
  disposeCompiledBroadSurfaceRegisteredCandidate,
  finalizeCompiledBroadSurfaceCandidateOwner,
  installCompiledBroadSurfaceCandidateOwner,
  type CompiledBroadTrackLayoutHost,
} from './indexed-compiled-broad-track-layout';

function policy(
  overrides: Partial<AnnotationPolicyGpuRuntimeV1> = {}
): AnnotationPolicyGpuRuntimeV1 {
  return { isoformMode: 'canonical', laneLimit: null, ...overrides };
}

function owner(
  trackId: string,
  extras: { canonicalRows?: number; presenter?: object } = {}
): CompiledBroadSurfaceTrackOwnerV2 {
  return {
    manifest: {
      trackId,
      laneRowCounts: { canonical: extras.canonicalRows ?? 3, expanded: 5 },
    },
    provenance: { trackId },
    presenter: extras.presenter ?? { id: trackId },
  } as unknown as CompiledBroadSurfaceTrackOwnerV2;
}

function layoutHost(
  overrides: Partial<CompiledBroadTrackLayoutHost> = {}
): CompiledBroadTrackLayoutHost {
  const host: CompiledBroadTrackLayoutHost = {
    compiledBroadSurfaceCandidateManifest: null,
    compiledBroadSurfaceCandidateProvenance: null,
    compiledBroadSurfaceCandidatePresenter: null,
    compiledBroadSurfaceTrackCandidateOwners: new Map(),
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceCandidateOwnerForTrack(trackId) {
      if (trackId.toLocaleLowerCase() === 'mrna') {
        const manifest = host.compiledBroadSurfaceCandidateManifest;
        const provenance = host.compiledBroadSurfaceCandidateProvenance;
        const presenter = host.compiledBroadSurfaceCandidatePresenter;
        if (!manifest || !provenance || !presenter) return null;
        return { manifest, provenance, presenter };
      }
      return host.compiledBroadSurfaceTrackCandidateOwners.get(trackId) ?? null;
    },
    installCompiledBroadSurfaceActiveOwner() {},
    disposeCompiledBroadSurfaceCandidate() {},
    disposeCompiledBroadSurfaceTrackOwner() {},
    prepackedAnnotationSceneResidentForTrack: () => null,
    annotationLayerTypesForPresentation: () => ['gene', 'mRNA'],
    annotationTrackRealizedLaneCapacity(trackId, nextPolicy, preserveLegacyFixedCapacity) {
      return annotationTrackRealizedLaneCapacity(
        host,
        trackId,
        nextPolicy,
        preserveLegacyFixedCapacity
      );
    },
    ...overrides,
  };
  return host;
}

describe('indexed compiled-broad track layout', () => {
  it('installs mRNA on the candidate slots and finalizes by clearing them', () => {
    const disposed: CompiledBroadSurfaceTrackOwnerV2[] = [];
    const previous = owner('mRNA', { presenter: { id: 'old' } });
    const next = owner('mRNA', { presenter: { id: 'new' } });
    const installed: CompiledBroadSurfaceTrackOwnerV2[] = [];
    const host = layoutHost({
      compiledBroadSurfaceOwnerForTrack(trackId) {
        return trackId === 'mRNA' ? previous : null;
      },
      installCompiledBroadSurfaceActiveOwner(active) {
        installed.push(active);
      },
      disposeCompiledBroadSurfaceTrackOwner(gone) {
        disposed.push(gone);
      },
    });

    installCompiledBroadSurfaceCandidateOwner(host, next);
    expect(host.compiledBroadSurfaceCandidateManifest).toBe(next.manifest);
    expect(host.compiledBroadSurfaceTrackCandidateOwners.size).toBe(0);

    finalizeCompiledBroadSurfaceCandidateOwner(host, next);
    expect(installed).toEqual([next]);
    expect(host.compiledBroadSurfaceCandidateManifest).toBeNull();
    expect(host.compiledBroadSurfaceCandidateProvenance).toBeNull();
    expect(host.compiledBroadSurfaceCandidatePresenter).toBeNull();
    expect(disposed).toEqual([previous]);
  });

  it('reads the capacity of each selected track exactly once for the full stack', () => {
    const roster = Array.from({ length: 144 }, (_, index) => `track-${index}`);
    const reads: string[] = [];
    const host = layoutHost({
      annotationLayerTypesForPresentation: () => [...roster, roster[0]],
      annotationTrackRealizedLaneCapacity(trackId) {
        reads.push(trackId);
        return 2;
      },
    });

    expect(annotationTrackStackMaxLane(host, policy())).toBe(430);
    expect(reads).toEqual(roster);
  });

  it('keeps ordered lane starts for case-distinct, duplicate, absent, and single tracks', () => {
    const roster = ['tRNA', 'Dm88', 'DM88', 'gene', 'Dm88', 'mRNA'];
    const host = layoutHost({
      annotationTrackRealizedLaneCapacity(trackId, _policy, single) {
        return single ? 8 : trackId === 'gene' ? 4 : 2;
      },
    });

    for (const selected of [[], ['mRNA'], roster]) {
      const laneStart = compiledBroadSurfaceRosterLaneStarts(host, selected, policy());
      for (const trackId of [...selected, 'missing']) {
        expect(laneStart(trackId)).toBe(
          compiledBroadSurfaceLaneStart(host, trackId, selected, policy())
        );
      }
    }
  });

  it('orders preferred tracks first and uses the legacy laneLimit only on a single-track stack', () => {
    const host = layoutHost({
      annotationLayerTypesForPresentation: () => ['tRNA', 'gene'],
      annotationTrackRealizedLaneCapacity(trackId) {
        return trackId === 'gene' ? 2 : 1;
      },
    });
    const requested = host.annotationLayerTypesForPresentation();
    expect(compiledBroadSurfaceLaneStart(host, 'gene', requested, policy())).toBe(0);
    expect(compiledBroadSurfaceLaneStart(host, 'tRNA', requested, policy())).toBe(3);
    expect(compiledBroadSurfaceLaneStart(host, 'missing', requested, policy())).toBe(5);
    expect(annotationTrackStackMaxLane(host, policy())).toBe(3);

    const limited = layoutHost({
      annotationLayerTypesForPresentation: () => ['mRNA'],
      compiledBroadSurfaceRequirement: null,
    });
    expect(annotationTrackRealizedLaneCapacity(limited, 'mRNA', policy({ laneLimit: 4 }))).toBe(4);
    expect(
      annotationTrackRealizedLaneCapacity(
        layoutHost({
          annotationLayerTypesForPresentation: () => ['gene', 'mRNA'],
        }),
        'mRNA',
        policy({ laneLimit: 4 })
      )
    ).toBe(1);

    const gene = owner('gene', { canonicalRows: 8 });
    const mapped = layoutHost();
    installCompiledBroadSurfaceCandidateOwner(mapped, gene);
    expect(mapped.compiledBroadSurfaceTrackCandidateOwners.get('gene')).toBe(gene);
    let candidateDisposed = 0;
    mapped.disposeCompiledBroadSurfaceTrackOwner = () => {
      candidateDisposed += 1;
    };
    disposeCompiledBroadSurfaceRegisteredCandidate(mapped, gene);
    expect(mapped.compiledBroadSurfaceTrackCandidateOwners.size).toBe(0);
    expect(candidateDisposed).toBe(1);
  });
});
