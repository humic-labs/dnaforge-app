import type {
  AnnotationPresentationSnapshot,
  AnnotationResidentPagePublication,
} from '../../../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidSnapshotIdentity(snapshot: Record<string, unknown>): boolean {
  return (
    snapshot.contract === 'annotation-presentation-snapshot.v1' &&
    typeof snapshot.sourceIdentity === 'string' &&
    snapshot.sourceIdentity.trim().length > 0 &&
    typeof snapshot.policyKey === 'string' &&
    snapshot.policyKey.trim().length > 0 &&
    typeof snapshot.genomeLengthBp === 'number' &&
    Number.isSafeInteger(snapshot.genomeLengthBp) &&
    snapshot.genomeLengthBp > 0 &&
    typeof snapshot.generation === 'number' &&
    Number.isSafeInteger(snapshot.generation) &&
    snapshot.generation >= 0
  );
}

function isValidSnapshotLayout(layout: unknown): layout is Record<string, unknown> {
  return (
    isRecord(layout) &&
    typeof layout.maxAnnotationLane === 'number' &&
    Number.isSafeInteger(layout.maxAnnotationLane) &&
    layout.maxAnnotationLane >= -1 &&
    typeof layout.maxCdsLane === 'number' &&
    Number.isSafeInteger(layout.maxCdsLane) &&
    layout.maxCdsLane >= -1
  );
}

function isValidSnapshotCoverage(coverage: unknown, genomeLengthBp: number): boolean {
  return (
    isRecord(coverage) &&
    typeof coverage.startBp === 'number' &&
    Number.isSafeInteger(coverage.startBp) &&
    typeof coverage.endBp === 'number' &&
    Number.isSafeInteger(coverage.endBp) &&
    coverage.startBp >= 0 &&
    coverage.endBp > coverage.startBp &&
    coverage.endBp <= genomeLengthBp
  );
}

function isValidSnapshotFeature(feature: unknown, genomeLengthBp: number): boolean {
  return (
    isRecord(feature) &&
    typeof feature.id === 'number' &&
    Number.isSafeInteger(feature.id) &&
    typeof feature.start === 'number' &&
    Number.isFinite(feature.start) &&
    typeof feature.end === 'number' &&
    Number.isFinite(feature.end) &&
    feature.start >= 0 &&
    feature.start < genomeLengthBp &&
    feature.end >= 0 &&
    feature.end <= genomeLengthBp &&
    typeof feature.lane === 'number' &&
    Number.isSafeInteger(feature.lane) &&
    feature.lane >= 0
  );
}

export function validAnnotationPresentationSnapshot(
  value: unknown
): value is AnnotationPresentationSnapshot {
  if (!isRecord(value)) return false;
  const snapshot = value;
  if (
    !isValidSnapshotIdentity(snapshot) ||
    !isValidSnapshotLayout(snapshot.layout) ||
    !Array.isArray(snapshot.features) ||
    !Array.isArray(snapshot.requestedLayerTypes) ||
    !Array.isArray(snapshot.exactCoverage)
  ) {
    return false;
  }
  if (
    snapshot.requestedLayerTypes.some(
      (layerType) => typeof layerType !== 'string' || layerType.trim().length === 0
    )
  ) {
    return false;
  }
  const genomeLengthBp = snapshot.genomeLengthBp as number;
  for (const coverage of snapshot.exactCoverage) {
    if (!isValidSnapshotCoverage(coverage, genomeLengthBp)) return false;
  }
  for (const feature of snapshot.features) {
    if (!isValidSnapshotFeature(feature, genomeLengthBp)) return false;
  }
  return true;
}

export function validAnnotationResidentPagePublication(
  value: unknown
): value is AnnotationResidentPagePublication {
  if (!isRecord(value)) return false;
  if (
    (value.contract !== 'annotation-resident-page-publication.v1' &&
      value.contract !== 'annotation-codon-carrier-page-publication.v1') ||
    typeof value.sourceIdentity !== 'string' ||
    value.sourceIdentity.trim().length === 0 ||
    typeof value.policyKey !== 'string' ||
    value.policyKey.trim().length === 0 ||
    !Number.isSafeInteger(value.genomeLengthBp) ||
    (value.genomeLengthBp as number) <= 0 ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !Array.isArray(value.requestedLayerTypes) ||
    value.requestedLayerTypes.some(
      (layerType) => typeof layerType !== 'string' || layerType.trim().length === 0
    ) ||
    !Array.isArray(value.exactCoverage) ||
    !Array.isArray(value.pages)
  ) {
    return false;
  }
  return value.exactCoverage.every(
    (coverage) =>
      isRecord(coverage) &&
      Number.isSafeInteger(coverage.startBp) &&
      Number.isSafeInteger(coverage.endBp) &&
      (coverage.startBp as number) >= 0 &&
      (coverage.endBp as number) > (coverage.startBp as number) &&
      (coverage.endBp as number) <= (value.genomeLengthBp as number)
  );
}
