export type AssemblyAnnotationRuntimePolicy = {
  isoformMode: 'canonical' | 'expanded';
  laneLimit: number | null;
};

export type AssemblyAnnotationPolicyRequest = {
  requestId: number;
  policy: AssemblyAnnotationRuntimePolicy;
};

export type AssemblyAnnotationPolicyPreparationPublication =
  | { status: 'prepare'; request: AssemblyAnnotationPolicyRequest }
  | { status: 'clear'; requestId: number };

export type AssemblyAnnotationPolicyFailureReason =
  | 'invalid-policy'
  | 'cache-miss'
  | 'cache-error'
  | 'ineligible'
  | 'policy-mismatch';

export type AssemblyAnnotationPolicyTransactionState =
  | { status: 'idle' }
  | { status: 'preparing'; request: AssemblyAnnotationPolicyRequest }
  | {
      status: 'failed';
      request: AssemblyAnnotationPolicyRequest;
      reason: AssemblyAnnotationPolicyFailureReason;
    };

export function isValidAssemblyAnnotationRuntimePolicy(
  policy: AssemblyAnnotationRuntimePolicy
): boolean {
  return (
    (policy.isoformMode === 'canonical' || policy.isoformMode === 'expanded') &&
    (policy.laneLimit === null || (Number.isSafeInteger(policy.laneLimit) && policy.laneLimit > 0))
  );
}

export function preparingAssemblyAnnotationPolicyRequest(
  transaction: AssemblyAnnotationPolicyTransactionState
): AssemblyAnnotationPolicyRequest | null {
  return transaction.status === 'preparing' ? transaction.request : null;
}

export type AssemblyAnnotationPresentationDescriptor = {
  sourceIdentity?: string;
  runtimeCacheKey?: string;
  sceneKey?: string;
  artifact?: { artifactKey?: string; trackType?: string };
};

export type AssemblyAnnotationPresentationReceipt = {
  descriptor: AssemblyAnnotationPresentationDescriptor;
  ownerKey: string;
  metadata: { genomeIdentity: string; artifactKey: string; trackType: string };
  runtimePolicy: AssemblyAnnotationRuntimePolicy;
};

export function isExactActiveMrnaPresentation(input: {
  receipt: AssemblyAnnotationPresentationReceipt | null;
  descriptor: AssemblyAnnotationPresentationDescriptor | null;
  effectiveLayerTypes: readonly string[];
  receiptRendererEpoch: number | null;
  currentRendererEpoch: number;
}): boolean {
  const { receipt, descriptor } = input;
  return Boolean(
    receipt &&
    descriptor &&
    input.receiptRendererEpoch === input.currentRendererEpoch &&
    input.effectiveLayerTypes.length === 1 &&
    input.effectiveLayerTypes[0] === 'mRNA' &&
    receipt.ownerKey.length > 0 &&
    descriptor.artifact?.trackType === 'mRNA' &&
    receipt.descriptor.sceneKey === descriptor.sceneKey &&
    receipt.descriptor.runtimeCacheKey === descriptor.runtimeCacheKey &&
    receipt.descriptor.sourceIdentity === descriptor.sourceIdentity &&
    receipt.descriptor.artifact?.artifactKey === descriptor.artifact.artifactKey &&
    receipt.descriptor.artifact?.trackType === descriptor.artifact.trackType &&
    receipt.metadata.genomeIdentity === descriptor.sourceIdentity &&
    receipt.metadata.artifactKey === descriptor.artifact.artifactKey &&
    receipt.metadata.trackType === descriptor.artifact.trackType
  );
}
