export type CompiledBroadDemandEarlyStatus =
  | { status: 'not-loaded' }
  | { status: 'rejected'; withPolicy: boolean }
  | { status: 'camera-required' };

export function compiledBroadDemandEarlyStatus(input: {
  hasManifest: boolean;
  hasPresenter: boolean;
  provenanceCurrent: boolean;
  policyValid: boolean;
  hasCamera: boolean;
}): CompiledBroadDemandEarlyStatus | null {
  if (!input.hasManifest || !input.hasPresenter) return { status: 'not-loaded' };
  if (!input.provenanceCurrent) return { status: 'rejected', withPolicy: false };
  if (!input.policyValid) return { status: 'rejected', withPolicy: true };
  if (!input.hasCamera) return { status: 'camera-required' };
  return null;
}
