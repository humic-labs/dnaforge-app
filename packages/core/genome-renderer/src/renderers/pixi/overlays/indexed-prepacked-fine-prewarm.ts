import { PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP } from '../overview/partitioned-instanced-transcript-layer';

export type PrepackedFinePrewarmViewport = {
  startBp: number;
  endBp: number;
  visibleBp: number;
};

export function clampPrepackedFinePrewarmViewport(input: {
  viewportStartBp: number;
  viewportEndBp: number;
  genomeLengthBp: number;
}): PrepackedFinePrewarmViewport | null {
  const startBp = Math.max(0, Math.floor(input.viewportStartBp));
  const endBp = Math.min(input.genomeLengthBp, Math.ceil(input.viewportEndBp));
  const visibleBp = endBp - startBp;
  if (
    !Number.isSafeInteger(startBp) ||
    !Number.isSafeInteger(endBp) ||
    visibleBp <= 0 ||
    visibleBp > PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP
  ) {
    return null;
  }
  return { startBp, endBp, visibleBp };
}

export type PrepackedFinePreparationResident = {
  ownerKey: string;
  layer: {
    isGpuPrepared: boolean;
    isCoarseFallbackPrepared: boolean;
    areFineViewsPrewarmed(startBp: number, endBp: number): boolean;
  };
};

export type PrepackedFinePreparationAction<TResident extends PrepackedFinePreparationResident> =
  | { kind: 'waiting-residents' }
  | { kind: 'complete' }
  | { kind: 'prepare-gpu'; resident: TResident }
  | { kind: 'prewarm-fine'; resident: TResident }
  | { kind: 'prepare-coarse'; resident: TResident };

export function nextPrepackedFinePreparationAction<
  TResident extends PrepackedFinePreparationResident,
>(input: {
  hasWebglRenderer: boolean;
  residents: ReadonlyArray<TResident | undefined>;
  startBp: number;
  endBp: number;
}): PrepackedFinePreparationAction<TResident> {
  if (
    !input.hasWebglRenderer ||
    input.residents.length === 0 ||
    input.residents.some((resident) => resident === undefined)
  ) {
    return { kind: 'waiting-residents' };
  }
  const residents = input.residents as readonly TResident[];
  const gpuPending = residents.find((resident) => !resident.layer.isGpuPrepared);
  if (gpuPending) return { kind: 'prepare-gpu', resident: gpuPending };
  const finePending = residents.find(
    (resident) => !resident.layer.areFineViewsPrewarmed(input.startBp, input.endBp)
  );
  if (finePending) return { kind: 'prewarm-fine', resident: finePending };
  const coarsePending = residents.find((resident) => !resident.layer.isCoarseFallbackPrepared);
  if (coarsePending) return { kind: 'prepare-coarse', resident: coarsePending };
  return { kind: 'complete' };
}

export function countPrepackedFinePreparationPending<
  TResident extends PrepackedFinePreparationResident,
>(input: {
  residents: ReadonlyArray<TResident>;
  startBp: number;
  endBp: number;
  includeGpu: boolean;
}): number {
  return input.residents.filter(
    (resident) =>
      (input.includeGpu && !resident.layer.isGpuPrepared) ||
      !resident.layer.areFineViewsPrewarmed(input.startBp, input.endBp) ||
      !resident.layer.isCoarseFallbackPrepared
  ).length;
}
