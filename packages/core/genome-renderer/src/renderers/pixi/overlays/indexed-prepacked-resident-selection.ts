import { findAnnotationTrackIdentity } from '../../../annotation-track-identity';

export type PrepackedViewportDetailLease =
  | {
      packetPayloadSha256?: string;
      sourceFingerprint?: string;
      interactionPayloadSha256?: string;
      coverageStartBp?: number;
      coverageEndBp?: number;
      handoffStartBp?: number;
      handoffEndBp?: number;
      empty?: boolean;
    }
  | null
  | undefined;

export type PrepackedPresentationResidentPick = {
  ownerKey: string;
  lastUsed: number;
  policyGeneration: number;
  viewportDetailPresentationAdmitted: boolean;
  metadata: {
    trackType: string;
    themeMode: string;
  };
  input: {
    viewportDetail?: PrepackedViewportDetailLease;
  };
};

export function sameViewportDetailPresentationLease(
  left: PrepackedViewportDetailLease,
  right: PrepackedViewportDetailLease
): boolean {
  return Boolean(
    left &&
    right &&
    left.packetPayloadSha256 === right.packetPayloadSha256 &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.interactionPayloadSha256 === right.interactionPayloadSha256 &&
    left.coverageStartBp === right.coverageStartBp &&
    left.coverageEndBp === right.coverageEndBp &&
    left.handoffStartBp === right.handoffStartBp &&
    left.handoffEndBp === right.handoffEndBp &&
    left.empty === right.empty
  );
}

export function selectAnnotationPresentationResident<
  TResident extends PrepackedPresentationResidentPick,
>(input: {
  readonly residents: readonly TResident[];
  readonly trackType: string;
  readonly themeMode: 'light' | 'dark';
  readonly policyGeneration: number;
  readonly viewportStartBp?: number;
  readonly viewportEndBp?: number;
  readonly requireAdmitted?: boolean;
  readonly ownerKey?: string;
}): TResident | undefined {
  const eligibleResidents = input.residents.filter((resident) => {
    const detail = resident.input.viewportDetail;
    return Boolean(
      resident.metadata.themeMode === input.themeMode &&
      resident.policyGeneration === input.policyGeneration &&
      (input.ownerKey === undefined || resident.ownerKey === input.ownerKey) &&
      (!input.requireAdmitted || resident.viewportDetailPresentationAdmitted) &&
      (detail == null ||
        ((input.viewportStartBp === undefined ||
          (detail.coverageStartBp ?? Number.NEGATIVE_INFINITY) <= input.viewportStartBp) &&
          (input.viewportEndBp === undefined ||
            (detail.coverageEndBp ?? Number.POSITIVE_INFINITY) >= input.viewportEndBp)))
    );
  });
  const resolvedIdentity = findAnnotationTrackIdentity(
    input.trackType,
    eligibleResidents,
    (resident) => resident.metadata.trackType
  );
  if (!resolvedIdentity) return undefined;
  return eligibleResidents
    .filter((resident) => resident.metadata.trackType === resolvedIdentity.metadata.trackType)
    .sort(
      (left, right) => right.lastUsed - left.lastUsed || left.ownerKey.localeCompare(right.ownerKey)
    )[0];
}
