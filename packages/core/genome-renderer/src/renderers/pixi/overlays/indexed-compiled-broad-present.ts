export function compiledBroadPresentHasProduct(input: {
  requestedLayerCount: number;
  hasRequirement: boolean;
  hasPresenter: boolean;
  hasCandidatePresenter: boolean;
  trackOwnerCount: number;
  candidateOwnerCount: number;
}): boolean {
  return (
    input.requestedLayerCount > 0 &&
    (input.hasRequirement ||
      input.hasPresenter ||
      input.hasCandidatePresenter ||
      input.trackOwnerCount > 0 ||
      input.candidateOwnerCount > 0)
  );
}

export type CompiledBroadPresentRosterPlan =
  | { kind: 'detail-required' }
  | { kind: 'retain'; status: 'broad-cells-missing' | 'rejected' }
  | { kind: 'continue' };

export function planCompiledBroadPresentRoster(input: {
  hasRequirement: boolean;
  requirementOwnsCamera: boolean;
  hasLayout: boolean;
  anyOwnerMissing: boolean;
  anyGenomeOrProvenanceStale: boolean;
  anyCandidateRegistrationMismatch: boolean;
}): CompiledBroadPresentRosterPlan {
  if (input.hasRequirement && !input.requirementOwnsCamera) return { kind: 'detail-required' };
  if (!input.hasLayout) return { kind: 'retain', status: 'rejected' };
  if (input.anyOwnerMissing) return { kind: 'retain', status: 'broad-cells-missing' };
  if (input.anyGenomeOrProvenanceStale || input.anyCandidateRegistrationMismatch) {
    return { kind: 'retain', status: 'rejected' };
  }
  return { kind: 'continue' };
}

export type CompiledBroadDerivedPlanAction =
  | 'detail-required'
  | 'retain-artifact'
  | 'retain-rejected'
  | 'ready';

export function compiledBroadDerivedPlanAction(status: string): CompiledBroadDerivedPlanAction {
  if (status === 'detail-required') return 'detail-required';
  if (status === 'broad-ready') return 'ready';
  if (status === 'broad-artifact-required') return 'retain-artifact';
  return 'retain-rejected';
}

export type CompiledBroadStageCommitAction =
  | 'stage'
  | 'already-active'
  | 'retain-missing'
  | 'retain-rejected';

export function compiledBroadStageCommitAction(status: string): CompiledBroadStageCommitAction {
  if (status === 'staged') return 'stage';
  if (status === 'already-active') return 'already-active';
  if (status === 'missing-cells') return 'retain-missing';
  return 'retain-rejected';
}

export function compiledBroadSteadyRosterPlanStatus(input: {
  holdingLastGood: boolean;
}): 'broad-holding-last-good' | 'broad-presenting' {
  return input.holdingLastGood ? 'broad-holding-last-good' : 'broad-presenting';
}
