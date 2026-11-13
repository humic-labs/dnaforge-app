export function isCompiledBroadDemandRefreshRequired(input: {
  policyValid: boolean;
  hasCurrentOwner: boolean;
  planStatus: string;
  detailStillOwnsLatestCamera: boolean;
  readyDetailMatchesCurrentLease: boolean;
  presenterOwnsCurrentCamera: boolean;
}): boolean {
  if (!input.policyValid || !input.hasCurrentOwner) return true;
  if (
    input.planStatus === 'detail-required' &&
    input.detailStillOwnsLatestCamera &&
    input.readyDetailMatchesCurrentLease
  ) {
    return false;
  }
  return !input.presenterOwnsCurrentCamera;
}
