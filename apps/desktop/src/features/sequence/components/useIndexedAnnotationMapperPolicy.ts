import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import {
  isValidAssemblyAnnotationRuntimePolicy,
  preparingAssemblyAnnotationPolicyRequest,
  type AssemblyAnnotationPolicyFailureReason,
  type AssemblyAnnotationPolicyPreparationPublication,
  type AssemblyAnnotationPolicyRequest,
  type AssemblyAnnotationPolicyTransactionState,
} from './assembly-annotation-policy-transaction';
import type { IndexedGenomeAnnotationMapperPolicy } from './AssemblyCompiledAnnotationTrack';
import type { AssemblyCompiledBroadRasterPolicyCommitReceiptV1 } from './assembly-compiled-broad-raster-loader';
import type { PrebuiltTextureAtomicCommitReceipt } from './usePrebuiltAssemblyOverviewTexture';

interface CompiledBroadPolicyReceiptBarrier {
  requestId: number;
  policy: IndexedGenomeAnnotationMapperPolicy;
  requiredTrackTypes: readonly string[];
  committedTrackTypes: Set<string>;
}

export function sameAnnotationMapperPolicy(
  left: IndexedGenomeAnnotationMapperPolicy,
  right: IndexedGenomeAnnotationMapperPolicy
): boolean {
  return left.isoformMode === right.isoformMode && left.laneLimit === right.laneLimit;
}

export function clampAnnotationMapperPolicyToLaneCapability(
  policy: IndexedGenomeAnnotationMapperPolicy,
  maxSupportedFiniteLaneLimit: number | null
): IndexedGenomeAnnotationMapperPolicy {
  if (
    maxSupportedFiniteLaneLimit === null ||
    (policy.laneLimit !== null && policy.laneLimit <= maxSupportedFiniteLaneLimit)
  ) {
    return policy;
  }
  return {
    ...policy,
    laneLimit: maxSupportedFiniteLaneLimit,
  };
}

export interface UseIndexedAnnotationMapperPolicyOptions {
  annotationMapperPolicy: IndexedGenomeAnnotationMapperPolicy;
  maxSupportedFiniteLaneLimit: number | null;
  commitAnnotationMapperPolicy: (next: IndexedGenomeAnnotationMapperPolicy) => void;
  allocateAnnotationMapperPolicyRequestId?: () => number;
  onAnnotationMapperPolicyPreparationRequest?: (
    publication: AssemblyAnnotationPolicyPreparationPublication
  ) => void;
  rendererAssemblyPresent: boolean;
  prepackedAnnotationSceneCacheStatus: 'not-applicable' | 'loading' | 'hit' | 'miss' | 'error';
  compiledBroadSurfaceEnabled: boolean;
  getCompiledBroadRequiredTrackTypes: () => readonly string[];
}

export interface UseIndexedAnnotationMapperPolicyResult {
  annotationPolicyTransaction: AssemblyAnnotationPolicyTransactionState;
  annotationPolicyTransactionRef: MutableRefObject<AssemblyAnnotationPolicyTransactionState>;
  pendingAnnotationMapperPolicy: AssemblyAnnotationPolicyRequest | null;
  requestAnnotationMapperPolicy: (requested: IndexedGenomeAnnotationMapperPolicy) => void;
  failAnnotationPolicyTransaction: (
    requestId: number,
    reason: AssemblyAnnotationPolicyFailureReason
  ) => void;
  handleAnnotationRasterAtomicCommitted: (receipt: PrebuiltTextureAtomicCommitReceipt) => void;
  acknowledgeCompiledBroadPolicyReceipt: (
    trackType: string,
    receipt: AssemblyCompiledBroadRasterPolicyCommitReceiptV1
  ) => void;
  isCompiledBroadPolicyReceiptBarrierTrack: (requestId: number, trackType: string) => boolean;
}

export function useIndexedAnnotationMapperPolicy({
  annotationMapperPolicy,
  maxSupportedFiniteLaneLimit,
  commitAnnotationMapperPolicy,
  allocateAnnotationMapperPolicyRequestId,
  onAnnotationMapperPolicyPreparationRequest,
  rendererAssemblyPresent,
  prepackedAnnotationSceneCacheStatus,
  compiledBroadSurfaceEnabled,
  getCompiledBroadRequiredTrackTypes,
}: UseIndexedAnnotationMapperPolicyOptions): UseIndexedAnnotationMapperPolicyResult {
  const linearizedAnnotationPolicyRequestIdRef = useRef<number | null>(null);
  const handleAnnotationRasterAtomicCommitted = useCallback(
    (receipt: PrebuiltTextureAtomicCommitReceipt) => {
      if (linearizedAnnotationPolicyRequestIdRef.current === receipt.requestId) return;
      linearizedAnnotationPolicyRequestIdRef.current = receipt.requestId;
      commitAnnotationMapperPolicy(receipt.policy);
    },
    [commitAnnotationMapperPolicy]
  );
  const [annotationPolicyTransaction, setAnnotationPolicyTransaction] =
    useState<AssemblyAnnotationPolicyTransactionState>({ status: 'idle' });
  const annotationPolicyTransactionRef = useRef(annotationPolicyTransaction);
  annotationPolicyTransactionRef.current = annotationPolicyTransaction;
  const compiledBroadPolicyReceiptBarrierRef = useRef<CompiledBroadPolicyReceiptBarrier | null>(
    null
  );
  const getCompiledBroadRequiredTrackTypesRef = useRef(getCompiledBroadRequiredTrackTypes);
  getCompiledBroadRequiredTrackTypesRef.current = getCompiledBroadRequiredTrackTypes;
  const reconcileSelectedPolicyTracks = useCallback(() => {
    const barrier = compiledBroadPolicyReceiptBarrierRef.current;
    if (!barrier) return null;
    const selected = new Set(getCompiledBroadRequiredTrackTypesRef.current());
    barrier.requiredTrackTypes = [...selected];
    for (const trackType of barrier.committedTrackTypes) {
      if (!selected.has(trackType)) barrier.committedTrackTypes.delete(trackType);
    }
    return barrier;
  }, []);
  const transitionAnnotationPolicyTransaction = useCallback(
    (next: AssemblyAnnotationPolicyTransactionState) => {
      if (next.status !== 'preparing') compiledBroadPolicyReceiptBarrierRef.current = null;
      annotationPolicyTransactionRef.current = next;
      setAnnotationPolicyTransaction(next);
    },
    []
  );
  const pendingAnnotationMapperPolicy = preparingAssemblyAnnotationPolicyRequest(
    annotationPolicyTransaction
  );
  const nextAnnotationPolicyRequestIdRef = useRef(1);
  const allocatePolicyRequestId = useCallback(
    () => allocateAnnotationMapperPolicyRequestId?.() ?? nextAnnotationPolicyRequestIdRef.current++,
    [allocateAnnotationMapperPolicyRequestId]
  );
  const publishAnnotationPolicyPreparationClear = useCallback(
    (requestId: number) =>
      onAnnotationMapperPolicyPreparationRequest?.({ status: 'clear', requestId }),
    [onAnnotationMapperPolicyPreparationRequest]
  );
  const completeSelectedPolicyBarrier = useCallback(() => {
    const barrier = reconcileSelectedPolicyTracks();
    const transaction = annotationPolicyTransactionRef.current;
    if (
      !barrier ||
      transaction.status !== 'preparing' ||
      transaction.request.requestId !== barrier.requestId ||
      linearizedAnnotationPolicyRequestIdRef.current === barrier.requestId ||
      barrier.requiredTrackTypes.some((trackType) => !barrier.committedTrackTypes.has(trackType))
    ) {
      return;
    }
    linearizedAnnotationPolicyRequestIdRef.current = barrier.requestId;
    compiledBroadPolicyReceiptBarrierRef.current = null;
    commitAnnotationMapperPolicy(barrier.policy);
    if (barrier.requiredTrackTypes.length === 0) {
      transitionAnnotationPolicyTransaction({ status: 'idle' });
      publishAnnotationPolicyPreparationClear(barrier.requestId);
    }
  }, [
    commitAnnotationMapperPolicy,
    publishAnnotationPolicyPreparationClear,
    reconcileSelectedPolicyTracks,
    transitionAnnotationPolicyTransaction,
  ]);
  const annotationPolicyPreparationPublicationRef = useRef(
    onAnnotationMapperPolicyPreparationRequest
  );
  annotationPolicyPreparationPublicationRef.current = onAnnotationMapperPolicyPreparationRequest;
  useEffect(
    () => () => {
      const transaction = annotationPolicyTransactionRef.current;
      if (transaction.status === 'preparing') {
        annotationPolicyPreparationPublicationRef.current?.({
          status: 'clear',
          requestId: transaction.request.requestId,
        });
      }
    },
    []
  );
  const requestAnnotationMapperPolicy = useCallback(
    (requested: IndexedGenomeAnnotationMapperPolicy) => {
      const next = clampAnnotationMapperPolicyToLaneCapability(
        requested,
        maxSupportedFiniteLaneLimit
      );
      const request = {
        requestId: allocatePolicyRequestId(),
        policy: next,
      };
      if (!isValidAssemblyAnnotationRuntimePolicy(next)) {
        const current = annotationPolicyTransactionRef.current;
        if (current.status === 'preparing') {
          publishAnnotationPolicyPreparationClear(current.request.requestId);
        }
        transitionAnnotationPolicyTransaction({
          status: 'failed',
          request,
          reason: 'invalid-policy',
        });
        return;
      }
      if (sameAnnotationMapperPolicy(annotationMapperPolicy, next)) {
        const current = annotationPolicyTransactionRef.current;
        if (current.status === 'preparing') {
          publishAnnotationPolicyPreparationClear(current.request.requestId);
        }
        transitionAnnotationPolicyTransaction({ status: 'idle' });
        return;
      }
      if (!rendererAssemblyPresent || prepackedAnnotationSceneCacheStatus === 'not-applicable') {
        const current = annotationPolicyTransactionRef.current;
        if (current.status === 'preparing') {
          publishAnnotationPolicyPreparationClear(current.request.requestId);
        }
        commitAnnotationMapperPolicy(next);
        transitionAnnotationPolicyTransaction({ status: 'idle' });
        return;
      }
      if (compiledBroadSurfaceEnabled) {
        compiledBroadPolicyReceiptBarrierRef.current = {
          requestId: request.requestId,
          policy: next,
          requiredTrackTypes: [...getCompiledBroadRequiredTrackTypesRef.current()],
          committedTrackTypes: new Set<string>(),
        };
      }
      transitionAnnotationPolicyTransaction({ status: 'preparing', request });
      if (!compiledBroadSurfaceEnabled) {
        onAnnotationMapperPolicyPreparationRequest?.({ status: 'prepare', request });
      }
    },
    [
      allocatePolicyRequestId,
      annotationMapperPolicy,
      commitAnnotationMapperPolicy,
      compiledBroadSurfaceEnabled,
      maxSupportedFiniteLaneLimit,
      onAnnotationMapperPolicyPreparationRequest,
      prepackedAnnotationSceneCacheStatus,
      publishAnnotationPolicyPreparationClear,
      rendererAssemblyPresent,
      transitionAnnotationPolicyTransaction,
    ]
  );
  const failAnnotationPolicyTransaction = useCallback(
    (requestId: number, reason: AssemblyAnnotationPolicyFailureReason) => {
      if (linearizedAnnotationPolicyRequestIdRef.current === requestId) return;
      const current = annotationPolicyTransactionRef.current;
      if (current.status !== 'preparing' || current.request.requestId !== requestId) return;
      transitionAnnotationPolicyTransaction({ status: 'failed', request: current.request, reason });
      publishAnnotationPolicyPreparationClear(requestId);
    },
    [publishAnnotationPolicyPreparationClear, transitionAnnotationPolicyTransaction]
  );
  useEffect(() => {
    if (
      !pendingAnnotationMapperPolicy ||
      !sameAnnotationMapperPolicy(annotationMapperPolicy, pendingAnnotationMapperPolicy.policy)
    ) {
      return;
    }
    transitionAnnotationPolicyTransaction({ status: 'idle' });
    publishAnnotationPolicyPreparationClear(pendingAnnotationMapperPolicy.requestId);
  }, [
    annotationMapperPolicy,
    pendingAnnotationMapperPolicy,
    publishAnnotationPolicyPreparationClear,
    transitionAnnotationPolicyTransaction,
  ]);
  useEffect(() => {
    completeSelectedPolicyBarrier();
  });
  const acknowledgeCompiledBroadPolicyReceipt = useCallback(
    (trackType: string, receipt: AssemblyCompiledBroadRasterPolicyCommitReceiptV1) => {
      if (receipt.policyRequestId === null) return;
      if (linearizedAnnotationPolicyRequestIdRef.current === receipt.policyRequestId) return;
      const transaction = annotationPolicyTransactionRef.current;
      const barrier = reconcileSelectedPolicyTracks();
      if (
        transaction.status !== 'preparing' ||
        transaction.request.requestId !== receipt.policyRequestId ||
        !sameAnnotationMapperPolicy(transaction.request.policy, receipt.policy) ||
        barrier?.requestId !== receipt.policyRequestId ||
        !sameAnnotationMapperPolicy(barrier.policy, receipt.policy) ||
        !barrier.requiredTrackTypes.includes(trackType)
      ) {
        return;
      }
      barrier.committedTrackTypes.add(trackType);
      completeSelectedPolicyBarrier();
    },
    [completeSelectedPolicyBarrier, reconcileSelectedPolicyTracks]
  );
  const isCompiledBroadPolicyReceiptBarrierTrack = useCallback(
    (requestId: number, trackType: string) => {
      const barrier = reconcileSelectedPolicyTracks();
      return barrier?.requestId === requestId && barrier.requiredTrackTypes.includes(trackType);
    },
    [reconcileSelectedPolicyTracks]
  );

  return {
    annotationPolicyTransaction,
    annotationPolicyTransactionRef,
    pendingAnnotationMapperPolicy,
    requestAnnotationMapperPolicy,
    failAnnotationPolicyTransaction,
    handleAnnotationRasterAtomicCommitted,
    acknowledgeCompiledBroadPolicyReceipt,
    isCompiledBroadPolicyReceiptBarrierTrack,
  };
}
