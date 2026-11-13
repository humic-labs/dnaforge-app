import {
  sameViewportDetailPresentationLease,
  type PrepackedViewportDetailLease,
} from './indexed-prepacked-resident-selection';

export function isIdempotentPrepackedSceneLoad(input: {
  existing:
    | {
        sourceInput: unknown;
        input: unknown;
        viewportDetail?: PrepackedViewportDetailLease;
      }
    | undefined;
  nextInput: unknown;
  nextViewportDetail?: PrepackedViewportDetailLease;
}): boolean {
  const existing = input.existing;
  if (!existing) return false;
  return (
    existing.sourceInput === input.nextInput ||
    existing.input === input.nextInput ||
    sameViewportDetailPresentationLease(existing.viewportDetail, input.nextViewportDetail)
  );
}

export function findReusablePrepackedSamePacketResident<
  TResident extends {
    input: { viewportDetail?: { packetPayloadSha256?: string } };
    layer: { isPresenting: boolean };
  },
>(input: {
  packetPayloadSha256: string | null;
  candidates: ReadonlyArray<TResident | null | undefined>;
  excludedCandidate?: TResident | null;
}): TResident | null {
  if (input.packetPayloadSha256 === null) return null;
  return (
    input.candidates.find(
      (candidate): candidate is TResident =>
        candidate != null &&
        candidate !== input.excludedCandidate &&
        candidate.input.viewportDetail?.packetPayloadSha256 === input.packetPayloadSha256 &&
        !candidate.layer.isPresenting
    ) ?? null
  );
}
