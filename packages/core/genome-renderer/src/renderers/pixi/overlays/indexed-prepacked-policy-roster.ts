export function residentHasPolicyPlane(resident: {
  input: {
    policyProjection?: unknown;
    policyGpuInstanceData?: unknown;
    submissionBank?: unknown;
    submissionFineIndices?: unknown;
  };
  policyTrackLaneMaxima?: unknown;
}): boolean {
  return Boolean(
    resident.input.policyProjection &&
    (resident.input.policyGpuInstanceData ||
      (resident.input.submissionBank && resident.input.submissionFineIndices)) &&
    resident.policyTrackLaneMaxima
  );
}

export function isPolicyLessResidentBlocking(input: {
  hasPolicyPlane: boolean;
  isActiveLayer: boolean;
  isRequestedTrack: boolean;
}): boolean {
  return !input.hasPolicyPlane && (input.isActiveLayer || input.isRequestedTrack);
}

export function isCompleteRequestedPolicyAuthorityRoster(input: {
  requestedPolicyPresent: readonly boolean[];
  compiledOwnerCurrent: readonly boolean[];
}): boolean {
  return input.requestedPolicyPresent.every(
    (present, index) => present || Boolean(input.compiledOwnerCurrent[index])
  );
}
