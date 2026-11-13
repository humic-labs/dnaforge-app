export type PrepackedPresentReadinessPlan<TResident> =
  | { kind: 'absent' }
  | { kind: 'status-absent'; status: 'variant-mismatch' | 'outside-corridor' }
  | { kind: 'dispose-absent'; status: 'variant-mismatch' }
  | { kind: 'pending'; status: 'fine-view-pending'; reason: 'viewport-coverage' }
  | {
      kind: 'hide-pending';
      status: 'fine-view-pending';
      reason: 'fine-views-not-prewarmed';
    }
  | {
      kind: 'present';
      residents: readonly TResident[];
      holdingLastComplete: boolean;
    };

export function planPrepackedPresentAfterResidents<TResident extends { ownerKey: string }>(input: {
  residents: readonly TResident[];
  holdingLastComplete: boolean;
  lastCompleteResidents: readonly TResident[] | null;
  policyGeneration: number;
  residentPolicyGeneration: (resident: TResident) => number;
  visibleBp: number;
  scaledBarHeightPx: number;
  residentBarHeightPx: (resident: TResident) => number;
  annotationTrackBase: number | null;
  coversViewport: (resident: TResident) => boolean;
  needsFinePreparation: (resident: TResident) => boolean;
}): PrepackedPresentReadinessPlan<TResident> {
  if (input.residents.length === 0) return { kind: 'absent' };
  if (
    input.residents.some(
      (resident) => input.residentPolicyGeneration(resident) !== input.policyGeneration
    )
  ) {
    return { kind: 'status-absent', status: 'variant-mismatch' };
  }
  if (!Number.isFinite(input.visibleBp) || input.visibleBp <= 0) {
    return { kind: 'status-absent', status: 'outside-corridor' };
  }
  if (
    input.residents.some(
      (resident) => input.residentBarHeightPx(resident) !== input.scaledBarHeightPx
    )
  ) {
    return { kind: 'dispose-absent', status: 'variant-mismatch' };
  }
  if (input.annotationTrackBase === null) {
    return { kind: 'status-absent', status: 'variant-mismatch' };
  }
  if (input.residents.some((resident) => !input.coversViewport(resident))) {
    return { kind: 'pending', status: 'fine-view-pending', reason: 'viewport-coverage' };
  }

  let residents = input.residents;
  let holdingLastComplete = input.holdingLastComplete;
  if (!holdingLastComplete && residents.some(input.needsFinePreparation)) {
    const lastCompleteResidents = input.lastCompleteResidents;
    const desiredOwnerKeys = new Set(residents.map(({ ownerKey }) => ownerKey));
    const canHoldLastComplete =
      lastCompleteResidents !== null &&
      lastCompleteResidents.some(({ ownerKey }) => !desiredOwnerKeys.has(ownerKey)) &&
      lastCompleteResidents.every(
        (resident) =>
          input.residentPolicyGeneration(resident) === input.policyGeneration &&
          input.residentBarHeightPx(resident) === input.scaledBarHeightPx &&
          !input.needsFinePreparation(resident)
      );
    if (canHoldLastComplete && lastCompleteResidents) {
      residents = lastCompleteResidents;
      holdingLastComplete = true;
    }
  }
  if (residents.some(input.needsFinePreparation)) {
    return {
      kind: 'hide-pending',
      status: 'fine-view-pending',
      reason: 'fine-views-not-prewarmed',
    };
  }
  return { kind: 'present', residents, holdingLastComplete };
}

export function prepackedFineSelectionIsExact(input: {
  requiresFinePresentation: boolean;
  isFinePresentationExact: boolean;
}): boolean {
  return !input.requiresFinePresentation || input.isFinePresentationExact;
}
