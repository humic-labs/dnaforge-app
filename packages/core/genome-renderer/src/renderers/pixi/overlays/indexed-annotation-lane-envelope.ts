import { resolveAnnotationTrackContract, type TrackContract } from '../shared/lane-contracts';
import type { UnifiedLayout } from '../shared/track-layout';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { AnnotationPolicyGpuTrackLaneMaximaV1 } from '../overview/annotation-policy-gpu-instances-v1';

export type LaneEnvelopeHost = {
  _layout: UnifiedLayout | null;
  _contract: TrackContract | null;
  maxAnnotationLane: number;
  maxCdsLane: number;
  maxLane: number;
  sourceMaxAnnotationLane: number;
  sourceMaxCdsLane: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  prepackedAnnotationSceneOwnerKey: string | null;
  prepackedAnnotationSceneResidents: {
    get(
      key: string
    ): { policyTrackLaneMaxima?: AnnotationPolicyGpuTrackLaneMaximaV1 | null } | undefined;
  };
  annotationTrackStackMaxLane(policy: AnnotationPolicyGpuRuntimeV1): number;
  applyPrepackedAnnotationLaneEnvelope(
    policy: AnnotationPolicyGpuRuntimeV1,
    maxima: AnnotationPolicyGpuTrackLaneMaximaV1
  ): void;
  commitAnnotationLaneEnvelope(maxAnnotationLane: number, maxCdsLane: number): void;
};

export function applyPrepackedAnnotationLaneEnvelope(
  host: LaneEnvelopeHost,
  policy: AnnotationPolicyGpuRuntimeV1,
  maxima: AnnotationPolicyGpuTrackLaneMaximaV1
): void {
  host.commitAnnotationLaneEnvelope(
    policy.laneLimit === null ? maxima[policy.isoformMode] : policy.laneLimit - 1,
    -1
  );
}

export function commitAnnotationLaneEnvelope(
  host: LaneEnvelopeHost,
  maxAnnotationLane: number,
  maxCdsLane: number
): void {
  const maxLane = Math.max(maxAnnotationLane, maxCdsLane);
  const contract = host._layout
    ? resolveAnnotationTrackContract({
        layout: host._layout,
        maxAnnotationLane,
        maxCdsLane,
      })
    : host._contract;
  host.maxAnnotationLane = maxAnnotationLane;
  host.maxCdsLane = maxCdsLane;
  host.maxLane = maxLane;
  host._contract = contract;
}

export function reconcileAnnotationLaneEnvelopeAuthority(host: LaneEnvelopeHost): void {
  if (host.prepackedAnnotationRuntimePolicy) {
    const policy = host.prepackedAnnotationRuntimePolicy;
    const stackMaxLane = host.annotationTrackStackMaxLane(policy);
    if (stackMaxLane >= 0) {
      host.commitAnnotationLaneEnvelope(stackMaxLane, -1);
      return;
    }
  }
  const resident = host.prepackedAnnotationSceneOwnerKey
    ? host.prepackedAnnotationSceneResidents.get(host.prepackedAnnotationSceneOwnerKey)
    : null;
  if (host.prepackedAnnotationRuntimePolicy && resident?.policyTrackLaneMaxima) {
    host.applyPrepackedAnnotationLaneEnvelope(
      host.prepackedAnnotationRuntimePolicy,
      resident.policyTrackLaneMaxima
    );
    return;
  }
  host.commitAnnotationLaneEnvelope(host.sourceMaxAnnotationLane, host.sourceMaxCdsLane);
}
