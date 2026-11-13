import { useEffect, useRef, useState } from 'react';
import {
  isPrebuiltAnnotationRasterLaneProjectionV1,
  isPrebuiltAnnotationRasterPresentationReceiptV1,
} from '@waypoint/genome-renderer/pure';

import type {
  AssemblyOverviewTexture,
  AssemblyOverviewTextureStatus,
} from './useAssemblyOverviewTexture';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';

interface UsePrebuiltAssemblyOverviewTextureOptions {
  overviewTexture: AssemblyOverviewTexture | null | undefined;
  overviewTextureStatus: AssemblyOverviewTextureStatus;
  rendererReadyEpoch: number;
  webglRef: {
    readonly current: Pick<IndexedGenomeTileNativeMapHandle, 'getLinearRenderer'> | null;
  };
  recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  atomicRequest?: PrebuiltTextureAtomicRequest | null;
  onAtomicCommitted?: (receipt: PrebuiltTextureAtomicCommitReceipt) => void;
}

export interface PrebuiltTextureAtomicPolicy {
  isoformMode: 'canonical' | 'expanded';
  laneLimit: number | null;
}

export interface PrebuiltTextureAtomicRequest {
  requestId: number;
  policy: PrebuiltTextureAtomicPolicy;
}

export interface PrebuiltTextureAtomicCommitReceipt {
  requestId: number;
  policy: PrebuiltTextureAtomicPolicy;
  artifactKey: string;
  rendererReadyEpoch: number;
}

export type PrebuiltTextureAtomicCommitState =
  | { status: 'idle'; requestId: null; policy: null; artifactKey: null }
  | {
      status: 'preparing';
      requestId: number;
      policy: PrebuiltTextureAtomicPolicy;
      artifactKey: string | null;
    }
  | {
      status: 'committed';
      requestId: number;
      policy: PrebuiltTextureAtomicPolicy;
      artifactKey: string;
    }
  | {
      status: 'error';
      requestId: number;
      policy: PrebuiltTextureAtomicPolicy;
      artifactKey: string | null;
    };

type PrebuiltTextureRenderer = {
  loadPrebuiltGenomeWideTexture?: (
    image: ImageBitmap,
    manifest: AssemblyOverviewTexture['manifest']
  ) => void;
  commitPrebuiltGenomeWideTexturePolicy?: (
    image: ImageBitmap,
    manifest: AssemblyOverviewTexture['manifest'],
    policy: PrebuiltTextureAtomicPolicy
  ) => boolean;
  clearPrebuiltGenomeWideTexture?: () => void;
};

type TextureAdmission = {
  renderer: object;
  rendererReadyEpoch: number;
  state: 'cleared' | 'loaded';
  artifactKey: string | null;
};

type AtomicAttempt = {
  renderer: object;
  key: string;
  state: Exclude<PrebuiltTextureAtomicCommitState, { status: 'idle' | 'preparing' }>;
};

function overviewTextureArtifactKey(manifest: AssemblyOverviewTexture['manifest']): string {
  const semanticReceipt = (manifest as { semanticReceipt?: unknown }).semanticReceipt;
  if (isPrebuiltAnnotationRasterPresentationReceiptV1(semanticReceipt)) {
    const rawLaneProjection = (manifest as { laneProjection?: unknown }).laneProjection;
    if (rawLaneProjection === undefined) {
      return `semantic:${semanticReceipt.artifactKey}:projection:legacy-uncapped`;
    }
    if (isPrebuiltAnnotationRasterLaneProjectionV1(rawLaneProjection)) {
      return `semantic:${semanticReceipt.artifactKey}:projection:${JSON.stringify([
        rawLaneProjection.contract,
        rawLaneProjection.laneLimit,
        rawLaneProjection.sourceHeightPx,
        rawLaneProjection.sourceSpineOffsetPx,
        rawLaneProjection.sourceMaxAnnotationLane,
        rawLaneProjection.presentedHeightPx,
        rawLaneProjection.presentedSpineOffsetPx,
      ])}`;
    }
  }

  return `physical:${JSON.stringify([
    manifest.fingerprint,
    manifest.cacheContractToken,
    manifest.sourceBuildFingerprint,
    manifest.placementSignature,
  ])}`;
}

export function usePrebuiltAssemblyOverviewTexture({
  overviewTexture,
  overviewTextureStatus,
  rendererReadyEpoch,
  webglRef,
  recordEvent,
  atomicRequest = null,
  onAtomicCommitted,
}: UsePrebuiltAssemblyOverviewTextureOptions): PrebuiltTextureAtomicCommitState {
  const admissionRef = useRef<TextureAdmission | null>(null);
  const atomicAttemptRef = useRef<AtomicAttempt | null>(null);
  const [atomicResult, setAtomicResult] = useState<{
    key: string;
    state: PrebuiltTextureAtomicCommitState;
  } | null>(null);
  const atomicPolicy = atomicRequest?.policy ?? null;
  const atomicArtifactKey =
    atomicRequest && overviewTextureStatus === 'loaded' && overviewTexture
      ? overviewTextureArtifactKey(overviewTexture.manifest)
      : null;
  const atomicTargetKey = atomicRequest
    ? JSON.stringify([
        rendererReadyEpoch,
        atomicRequest.requestId,
        atomicArtifactKey,
        atomicRequest.policy.isoformMode,
        atomicRequest.policy.laneLimit,
      ])
    : null;

  useEffect(() => {
    if (rendererReadyEpoch <= 0) return;
    const renderer = webglRef.current?.getLinearRenderer?.() as
      | PrebuiltTextureRenderer
      | null
      | undefined;
    if (!renderer) return;

    const previous = admissionRef.current;
    const sameRendererEpoch =
      previous?.renderer === renderer && previous.rendererReadyEpoch === rendererReadyEpoch;

    if (atomicRequest && atomicPolicy) {
      if (
        overviewTextureStatus !== 'loaded' ||
        !overviewTexture ||
        !atomicArtifactKey ||
        !atomicTargetKey
      ) {
        return;
      }
      const priorAtomicAttempt = atomicAttemptRef.current;
      if (priorAtomicAttempt?.renderer === renderer && priorAtomicAttempt.key === atomicTargetKey) {
        if (
          atomicResult?.key !== atomicTargetKey ||
          atomicResult.state !== priorAtomicAttempt.state
        ) {
          setAtomicResult({ key: atomicTargetKey, state: priorAtomicAttempt.state });
        }
        return;
      }
      if (
        sameRendererEpoch &&
        previous.state === 'loaded' &&
        previous.artifactKey === atomicArtifactKey &&
        atomicResult?.key === atomicTargetKey &&
        atomicResult.state.status === 'committed'
      ) {
        return;
      }
      if (atomicResult?.key === atomicTargetKey && atomicResult.state.status === 'error') {
        return;
      }
      const committed =
        renderer.commitPrebuiltGenomeWideTexturePolicy?.(
          overviewTexture.image,
          overviewTexture.manifest,
          atomicPolicy
        ) === true;
      if (!committed) {
        const state = {
          status: 'error' as const,
          requestId: atomicRequest.requestId,
          policy: { ...atomicPolicy },
          artifactKey: atomicArtifactKey,
        };
        atomicAttemptRef.current = { renderer, key: atomicTargetKey, state };
        setAtomicResult({
          key: atomicTargetKey,
          state,
        });
        recordEvent('overview-texture-policy-commit-failed', {
          artifactKey: atomicArtifactKey,
          isoformMode: atomicPolicy.isoformMode,
          laneLimit: atomicPolicy.laneLimit,
        });
        return;
      }
      admissionRef.current = {
        renderer,
        rendererReadyEpoch,
        state: 'loaded',
        artifactKey: atomicArtifactKey,
      };
      const state = {
        status: 'committed' as const,
        requestId: atomicRequest.requestId,
        policy: { ...atomicPolicy },
        artifactKey: atomicArtifactKey,
      };
      atomicAttemptRef.current = { renderer, key: atomicTargetKey, state };
      onAtomicCommitted?.({
        requestId: state.requestId,
        policy: state.policy,
        artifactKey: state.artifactKey,
        rendererReadyEpoch,
      });
      setAtomicResult({
        key: atomicTargetKey,
        state,
      });
      recordEvent('overview-texture-policy-committed', {
        artifactKey: atomicArtifactKey,
        isoformMode: atomicPolicy.isoformMode,
        laneLimit: atomicPolicy.laneLimit,
      });
      return;
    }

    if (overviewTextureStatus !== 'loaded' || !overviewTexture) {
      if (!renderer.clearPrebuiltGenomeWideTexture) return;
      if (sameRendererEpoch && previous.state === 'cleared') return;
      renderer.clearPrebuiltGenomeWideTexture();
      admissionRef.current = {
        renderer,
        rendererReadyEpoch,
        state: 'cleared',
        artifactKey: null,
      };
      recordEvent('overview-texture-cleared', { status: overviewTextureStatus });
      return;
    }

    if (!renderer.loadPrebuiltGenomeWideTexture) return;
    const artifactKey = overviewTextureArtifactKey(overviewTexture.manifest);
    if (sameRendererEpoch && previous.state === 'loaded' && previous.artifactKey === artifactKey) {
      return;
    }

    renderer.loadPrebuiltGenomeWideTexture(overviewTexture.image, overviewTexture.manifest);
    admissionRef.current = {
      renderer,
      rendererReadyEpoch,
      state: 'loaded',
      artifactKey,
    };
    recordEvent('overview-texture-loaded', {
      widthPx: overviewTexture.manifest.widthPx,
      genomeLength: overviewTexture.manifest.genomeLength,
    });
  }, [
    atomicArtifactKey,
    atomicRequest?.requestId,
    atomicPolicy?.isoformMode,
    atomicPolicy?.laneLimit,
    atomicResult,
    atomicTargetKey,
    overviewTexture,
    overviewTextureStatus,
    onAtomicCommitted,
    recordEvent,
    rendererReadyEpoch,
    webglRef,
  ]);

  if (!atomicRequest || !atomicPolicy || !atomicTargetKey) {
    return { status: 'idle', requestId: null, policy: null, artifactKey: null };
  }
  return atomicResult?.key === atomicTargetKey
    ? atomicResult.state
    : {
        status: 'preparing',
        requestId: atomicRequest.requestId,
        policy: { ...atomicPolicy },
        artifactKey: atomicArtifactKey,
      };
}
