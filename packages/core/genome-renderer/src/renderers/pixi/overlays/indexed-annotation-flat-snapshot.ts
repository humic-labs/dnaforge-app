import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationPresentationSnapshotApplyResult,
  Feature,
  Genome,
} from '../../../types';
import { validAnnotationPresentationSnapshot } from './annotation-presentation-snapshot-validate';
import { recordAnnotationPresentationSnapshotApply } from './annotation-presentation-debug';
import { PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1 } from '../overview/prebuilt-annotation-raster-contract';

export type FlatPresentationSnapshotHost = {
  currentGenomeIdentity: string | null;
  genomeLength: number;
  genomeCircular: boolean;
  currentAnnotationSourceFingerprint: string | null;
  currentAnnotationPlacementFingerprint: string | null;
  annotationPresentationStreams: Map<
    string,
    { generation: number; snapshot: AnnotationFlatPresentationSnapshot }
  >;
  activeAnnotationPresentationStreamKey: string | null;
  applyAnnotationGenome(genome: Genome): void;
};

export function setAnnotationFlatPresentationSnapshot(
  host: FlatPresentationSnapshotHost,
  snapshot: AnnotationFlatPresentationSnapshot
): AnnotationPresentationSnapshotApplyResult {
  if (!host.currentGenomeIdentity || host.genomeLength <= 0) {
    return { status: 'rejected', reason: 'no-genome' };
  }
  if (!validAnnotationPresentationSnapshot(snapshot)) {
    return { status: 'rejected', reason: 'invalid-contract' };
  }
  if (snapshot.sourceIdentity !== host.currentGenomeIdentity) {
    return { status: 'rejected', reason: 'source-mismatch' };
  }
  if (snapshot.genomeLengthBp !== host.genomeLength) {
    return { status: 'rejected', reason: 'length-mismatch' };
  }

  const streamKey = `${snapshot.sourceIdentity}\u0000${snapshot.policyKey}`;
  const accepted = host.annotationPresentationStreams.get(streamKey);
  if (accepted) {
    if (snapshot.generation < accepted.generation) {
      return { status: 'rejected', reason: 'stale-generation' };
    }
    if (snapshot.generation === accepted.generation) {
      if (snapshot !== accepted.snapshot) {
        return { status: 'rejected', reason: 'generation-collision' };
      }
      if (host.activeAnnotationPresentationStreamKey === streamKey) {
        return { status: 'noop', generation: snapshot.generation };
      }
    }
  }

  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  const annotationSourcePlacementProvenance =
    host.currentAnnotationSourceFingerprint && host.currentAnnotationPlacementFingerprint
      ? {
          contract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
          sourceFingerprint: host.currentAnnotationSourceFingerprint,
          placementFingerprint: host.currentAnnotationPlacementFingerprint,
        }
      : undefined;
  host.applyAnnotationGenome({
    name: snapshot.sourceIdentity,
    sourceIdentity: snapshot.sourceIdentity,
    length: snapshot.genomeLengthBp,
    circular: host.genomeCircular,
    ...(annotationSourcePlacementProvenance ? { annotationSourcePlacementProvenance } : undefined),
    features: snapshot.features.map((feature: Feature) => ({ ...feature })),
    annotationLayerTypes: [...snapshot.requestedLayerTypes],
    annotationLayout: { ...snapshot.layout },
    annotationExactCoverage: snapshot.exactCoverage.map((coverage) => ({ ...coverage })),
  });
  host.annotationPresentationStreams.set(streamKey, {
    generation: snapshot.generation,
    snapshot,
  });
  while (host.annotationPresentationStreams.size > 2) {
    const obsolete = [...host.annotationPresentationStreams.keys()].find(
      (key) => key !== streamKey
    );
    if (obsolete === undefined) break;
    host.annotationPresentationStreams.delete(obsolete);
  }
  host.activeAnnotationPresentationStreamKey = streamKey;
  const endedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  recordAnnotationPresentationSnapshotApply(snapshot, endedAt - startedAt);
  return { status: 'applied', generation: snapshot.generation, invalidatedHover: true };
}
