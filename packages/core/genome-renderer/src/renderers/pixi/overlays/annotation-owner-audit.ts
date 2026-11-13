import type { AnnotationPresentationDebugSnapshot } from './annotation-presentation-debug';

export type AnnotationOwnerAuditFrame = {
  presentedAtMs: number;
  themeMode: 'light' | 'dark';
  hoveredFeatureId: number | null;
  presenting: string[];
  presentingCount: number;
  doubleDraw: boolean;
  ownerViolations: string[];
  immediatePresenting: boolean;
  immediateDrawnCount: number;
  immediateTranscriptDrawnCount: number;
  cameraStartBp: number;
  cameraEndBp: number;
  cameraSpanBp: number;
  compiledBroadCameraOwned: boolean | null;
  compiledBroadPlanStatus: string;
  prepackedFinePendingReason: string | null;
  prepackedSceneStatus: string;
  prepackedResidentOwnerCount: number;
  prepackedLastCompleteOwnerCount: number;
  prepackedReplacementCandidateCount: number;
  prepackedReplacementCoverageStartBp: number | null;
  prepackedReplacementCoverageEndBp: number | null;
  prepackedReplacementPresentationAdmitted: boolean | null;
  prepackedReplacementFineViewsPrewarmed: boolean | null;
};

export interface AnnotationOwnerAuditRing {
  frames: AnnotationOwnerAuditFrame[];
  maxFrames: number;
  enabled?: boolean;
  violations?: number;
  writeIndex?: number;
  totalFrames?: number;
  latestFrame?: AnnotationOwnerAuditFrame;
}

export function sampleFineViewPrewarmForOwnerAudit(input: {
  cameraStartBp: number;
  cameraEndBp: number;
  genomeLengthBp: number;
  sample: (startBp: number, endBp: number) => boolean;
}): boolean | null {
  if (
    !Number.isFinite(input.cameraStartBp) ||
    !Number.isFinite(input.cameraEndBp) ||
    !Number.isSafeInteger(input.genomeLengthBp) ||
    input.genomeLengthBp <= 0
  ) {
    return null;
  }
  const startBp = Math.max(0, Math.floor(input.cameraStartBp));
  const endBp = Math.min(input.genomeLengthBp, Math.ceil(input.cameraEndBp));
  if (endBp <= startBp) return null;
  try {
    return input.sample(startBp, endBp);
  } catch {
    return null;
  }
}

export function appendAnnotationOwnerAuditFrame(
  ring: AnnotationOwnerAuditRing,
  frame: AnnotationOwnerAuditFrame
): void {
  const maxFrames = Math.max(1, Math.floor(ring.maxFrames));
  if (ring.frames.length < maxFrames) {
    ring.frames.push(frame);
  } else {
    const writeIndex = (ring.writeIndex ?? 0) % maxFrames;
    ring.frames[writeIndex] = frame;
    ring.writeIndex = (writeIndex + 1) % maxFrames;
  }
  ring.totalFrames = (ring.totalFrames ?? 0) + 1;
  ring.latestFrame = frame;
}

export function annotationOwnerAuditFrameFromPresentation(
  presentation: AnnotationPresentationDebugSnapshot,
  input: {
    presentedAtMs: number;
    themeMode: 'light' | 'dark';
    hoveredFeatureId: number | null;
    immediatePresenting: boolean;
    immediateDrawnCount: number;
    immediateTranscriptDrawnCount: number;
    cameraStartBp: number;
    cameraEndBp: number;
    compiledBroadCameraOwned: boolean | null;
    compiledBroadPlanStatus: string;
    prepackedFinePendingReason: string | null;
    prepackedSceneStatus: string;
    prepackedResidentOwnerCount: number;
    prepackedLastCompleteOwnerCount: number;
    prepackedReplacementCandidateCount: number;
    prepackedReplacementCoverageStartBp: number | null;
    prepackedReplacementCoverageEndBp: number | null;
    prepackedReplacementPresentationAdmitted: boolean | null;
    prepackedReplacementFineViewsPrewarmed: boolean | null;
  }
): AnnotationOwnerAuditFrame {
  const presenting = presentation.annotationPresentationOwners
    .filter((owner) => owner.visible && owner.visualGroups.length > 0)
    .map((owner) => owner.ownerId);
  const ownerViolations = presentation.annotationPresentationOwnerViolations;
  return {
    presentedAtMs: input.presentedAtMs,
    themeMode: input.themeMode,
    hoveredFeatureId: input.hoveredFeatureId,
    presenting,
    presentingCount: presenting.length,
    doubleDraw: ownerViolations.some(isDoubleDrawViolation),
    ownerViolations,
    immediatePresenting: input.immediatePresenting,
    immediateDrawnCount: input.immediateDrawnCount,
    immediateTranscriptDrawnCount: input.immediateTranscriptDrawnCount,
    cameraStartBp: input.cameraStartBp,
    cameraEndBp: input.cameraEndBp,
    cameraSpanBp: input.cameraEndBp - input.cameraStartBp,
    compiledBroadCameraOwned: input.compiledBroadCameraOwned,
    compiledBroadPlanStatus: input.compiledBroadPlanStatus,
    prepackedFinePendingReason: input.prepackedFinePendingReason,
    prepackedSceneStatus: input.prepackedSceneStatus,
    prepackedResidentOwnerCount: input.prepackedResidentOwnerCount,
    prepackedLastCompleteOwnerCount: input.prepackedLastCompleteOwnerCount,
    prepackedReplacementCandidateCount: input.prepackedReplacementCandidateCount,
    prepackedReplacementCoverageStartBp: input.prepackedReplacementCoverageStartBp,
    prepackedReplacementCoverageEndBp: input.prepackedReplacementCoverageEndBp,
    prepackedReplacementPresentationAdmitted: input.prepackedReplacementPresentationAdmitted,
    prepackedReplacementFineViewsPrewarmed: input.prepackedReplacementFineViewsPrewarmed,
  };
}

function isDoubleDrawViolation(violation: string): boolean {
  return (
    violation.startsWith('duplicate-exact-annotation-owner:') ||
    violation.startsWith('floor-overlaps-exact-annotation-owner:') ||
    violation === 'forbidden-runtime-genome-wide-texture-visible'
  );
}
