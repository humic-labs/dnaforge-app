import { PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1 } from '../overview/prepacked-annotation-scene';

const SHA24 = /^[0-9a-f]{24}$/;
const SHA64 = /^[0-9a-f]{64}$/;

export type PrepackedViewportDetailPacketView = {
  contract?: string;
  packetPayloadSha256?: string;
  sourceFingerprint?: string;
  interactionPayloadSha256?: string;
  sourceScene?: {
    byteLength?: number;
    payloadSha256?: string;
    contractSha256?: string;
  };
  empty?: boolean;
  coverageStartBp?: number;
  coverageEndBp?: number;
  handoffStartBp?: number;
  handoffEndBp?: number;
};

export type PrepackedViewportDetailCompiledInteractionView = {
  ownerKey?: string;
  sourceFingerprint?: string;
  interactionPayloadSha256?: string;
  policyProjection?: unknown;
  sourceScene?: {
    byteCount?: number;
    payloadSha256?: string;
    contractSha256?: string;
  };
};

export type PrepackedViewportDetailPacketChecks = {
  contract: boolean;
  packetDigest: boolean;
  sourceFingerprint: boolean;
  interactionDigest: boolean;
  sourceSceneLength: boolean;
  sourceScenePayload: boolean;
  sourceSceneContract: boolean;
  coverage: boolean;
  handoff: boolean;
  compiledInteractionPresent: boolean;
  owner: boolean;
  sourceFingerprintJoin: boolean;
  sourceSceneLengthJoin: boolean;
  sourceScenePayloadJoin: boolean;
  sourceSceneContractJoin: boolean;
  interactionDigestJoin: boolean;
  policyProjectionIdentity: boolean;
  packetCapability: boolean;
  interactionCapability: boolean;
  empty: boolean;
};

export function inspectPrepackedViewportDetailPacket(input: {
  viewportDetail: PrepackedViewportDetailPacketView | undefined;
  ownerKey: string;
  genomeLengthBp: number;
  policyProjection: unknown;
  trustedViewportDetailPacketAdmissionV1: unknown;
  trustedViewportDetailInteractionAdmissionV1: unknown;
  compiledInteraction: PrepackedViewportDetailCompiledInteractionView | null | undefined;
}): { valid: boolean; checks: PrepackedViewportDetailPacketChecks | null } {
  const viewportDetail = input.viewportDetail;
  if (viewportDetail === undefined) return { valid: true, checks: null };
  const compiledInteraction = input.compiledInteraction ?? null;
  const checks: PrepackedViewportDetailPacketChecks = {
    contract: viewportDetail.contract === PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
    packetDigest: SHA64.test(viewportDetail.packetPayloadSha256 ?? ''),
    sourceFingerprint: SHA24.test(viewportDetail.sourceFingerprint ?? ''),
    interactionDigest: SHA64.test(viewportDetail.interactionPayloadSha256 ?? ''),
    sourceSceneLength:
      Number.isSafeInteger(viewportDetail.sourceScene?.byteLength) &&
      (viewportDetail.sourceScene?.byteLength ?? 0) > 0,
    sourceScenePayload: SHA64.test(viewportDetail.sourceScene?.payloadSha256 ?? ''),
    sourceSceneContract: SHA64.test(viewportDetail.sourceScene?.contractSha256 ?? ''),
    coverage:
      Number.isSafeInteger(viewportDetail.coverageStartBp) &&
      Number.isSafeInteger(viewportDetail.coverageEndBp) &&
      (viewportDetail.coverageStartBp ?? -1) >= 0 &&
      (viewportDetail.coverageEndBp ?? 0) > (viewportDetail.coverageStartBp ?? 0) &&
      (viewportDetail.coverageEndBp ?? 0) <= input.genomeLengthBp,
    handoff:
      Number.isSafeInteger(viewportDetail.handoffStartBp) &&
      Number.isSafeInteger(viewportDetail.handoffEndBp) &&
      (viewportDetail.handoffStartBp ?? -1) >= (viewportDetail.coverageStartBp ?? 0) &&
      (viewportDetail.handoffEndBp ?? 0) > (viewportDetail.handoffStartBp ?? 0) &&
      (viewportDetail.handoffEndBp ?? 0) <= (viewportDetail.coverageEndBp ?? 0),
    compiledInteractionPresent: compiledInteraction !== null,
    owner: compiledInteraction?.ownerKey === input.ownerKey,
    sourceFingerprintJoin:
      compiledInteraction?.sourceFingerprint === viewportDetail.sourceFingerprint,
    sourceSceneLengthJoin:
      compiledInteraction?.sourceScene?.byteCount === viewportDetail.sourceScene?.byteLength,
    sourceScenePayloadJoin:
      compiledInteraction?.sourceScene?.payloadSha256 === viewportDetail.sourceScene?.payloadSha256,
    sourceSceneContractJoin:
      compiledInteraction?.sourceScene?.contractSha256 ===
      viewportDetail.sourceScene?.contractSha256,
    interactionDigestJoin:
      compiledInteraction?.interactionPayloadSha256 === viewportDetail.interactionPayloadSha256,
    policyProjectionIdentity: input.policyProjection === compiledInteraction?.policyProjection,
    packetCapability: input.trustedViewportDetailPacketAdmissionV1 !== undefined,
    interactionCapability: input.trustedViewportDetailInteractionAdmissionV1 !== undefined,
    empty: typeof viewportDetail.empty === 'boolean',
  };
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
  };
}

export type PrepackedViewportDetailRosterResident = {
  input: {
    viewportDetail?: {
      coverageStartBp: number;
      coverageEndBp: number;
    };
  };
  layer: {
    isCoarseFallbackPrepared: boolean;
    areFineViewsPrewarmed(startBp: number, endBp: number): boolean;
  };
};

export function selectAdmissiblePrepackedViewportDetailRoster<
  TResident extends PrepackedViewportDetailRosterResident,
>(input: {
  viewportStartBp: number;
  viewportEndBp: number;
  genomeLengthBp: number;
  roster: ReadonlyArray<TResident | undefined>;
}): { startBp: number; endBp: number; residents: TResident[] } | null {
  const startBp = Math.max(0, Math.floor(input.viewportStartBp));
  const endBp = Math.min(input.genomeLengthBp, Math.ceil(input.viewportEndBp));
  if (endBp <= startBp) return null;
  if (input.roster.length === 0 || input.roster.some((resident) => resident === undefined)) {
    return null;
  }
  const residents = input.roster as TResident[];
  if (
    residents.some((resident) => {
      const detail = resident.input.viewportDetail;
      return (
        !detail ||
        detail.coverageStartBp > startBp ||
        detail.coverageEndBp < endBp ||
        !resident.layer.areFineViewsPrewarmed(startBp, endBp) ||
        !resident.layer.isCoarseFallbackPrepared
      );
    })
  ) {
    return null;
  }
  return { startBp, endBp, residents };
}
