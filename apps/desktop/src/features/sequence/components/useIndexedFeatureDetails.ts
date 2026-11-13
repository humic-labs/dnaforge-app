import { useCallback, useEffect, useRef, useState } from 'react';

import type { GenomeFeatureDetails } from '../../../shared/indexed-genome';
import { platform } from '../../../platform';
import type { Assembly } from '@waypoint/genome-renderer';
import type { IndexedGenomeSelectedAnnotation } from './IndexedGenomeTileNativeMap';
import type { AssemblySegmentRouterResult } from './useAssemblySegmentRouter';
import { resolveFeatureDetailsCoords } from './indexed-genome-feature-details-coords';

export type FeatureDetailsState =
  | { kind: 'idle' }
  | { kind: 'loading'; annotation: IndexedGenomeSelectedAnnotation }
  | { kind: 'ready'; annotation: IndexedGenomeSelectedAnnotation; details: GenomeFeatureDetails }
  | { kind: 'error'; annotation: IndexedGenomeSelectedAnnotation; message: string };

interface UseIndexedFeatureDetailsOptions {
  sessionId?: string;
  manifestChrom: string;
  rendererAssembly: Assembly | null;
  assemblyRoutingEnabled: boolean;
  ensureAssemblySessionForChrom: AssemblySegmentRouterResult['ensureSessionForChrom'];
  recordEvent: (event: string, detail?: Record<string, unknown>) => void;
}

export function useIndexedFeatureDetails({
  sessionId,
  manifestChrom,
  rendererAssembly,
  assemblyRoutingEnabled,
  ensureAssemblySessionForChrom,
  recordEvent,
}: UseIndexedFeatureDetailsOptions) {
  const [selectedAnnotation, setSelectedAnnotation] =
    useState<IndexedGenomeSelectedAnnotation | null>(null);
  const [featureDetailsState, setFeatureDetailsState] = useState<FeatureDetailsState>({
    kind: 'idle',
  });
  const featureDetailsStateRef = useRef(featureDetailsState);
  featureDetailsStateRef.current = featureDetailsState;
  const featureDetailsTokenRef = useRef(0);
  const featureDetailsPendingRequestRef = useRef<string | null>(null);
  const featureDetailsSessionRef = useRef<string | null>(null);

  const handleSelectedAnnotationChange = useCallback(
    (annotation: IndexedGenomeSelectedAnnotation | null) => {
      setSelectedAnnotation(annotation);
    },
    []
  );

  useEffect(() => {
    cancelGenomeRequest(
      featureDetailsSessionRef.current ?? sessionId,
      featureDetailsPendingRequestRef.current
    );
    featureDetailsPendingRequestRef.current = null;
    featureDetailsSessionRef.current = null;
    if (!selectedAnnotation || !sessionId) {
      featureDetailsTokenRef.current += 1;
      setFeatureDetailsState({ kind: 'idle' });
      return;
    }

    const token = ++featureDetailsTokenRef.current;
    const requestId = `feature-details-${token}`;
    featureDetailsPendingRequestRef.current = requestId;
    setFeatureDetailsState({ kind: 'loading', annotation: selectedAnnotation });

    const assemblyForCoords = assemblyRoutingEnabled ? rendererAssembly : null;
    const coords = resolveFeatureDetailsCoords(selectedAnnotation, {
      rendererAssembly: assemblyForCoords,
      anchorChrom: manifestChrom,
    });
    if (!coords) {
      featureDetailsPendingRequestRef.current = null;
      setFeatureDetailsState({
        kind: 'error',
        annotation: selectedAnnotation,
        message: 'Could not resolve feature coordinates on the assembly axis.',
      });
      return;
    }

    void (async () => {
      let fetchSessionId = sessionId;
      if (assemblyForCoords) {
        const handle = await ensureAssemblySessionForChrom(coords.chrom);
        if (token !== featureDetailsTokenRef.current) return;
        if (!handle) {
          featureDetailsPendingRequestRef.current = null;
          setFeatureDetailsState({
            kind: 'error',
            annotation: selectedAnnotation,
            message: `Could not open the ${coords.chrom} session for feature details.`,
          });
          return;
        }
        fetchSessionId = handle.sessionId;
      }
      featureDetailsSessionRef.current = fetchSessionId;
      recordEvent('feature-details-request', {
        token,
        name: selectedAnnotation.name,
        type: selectedAnnotation.type,
        chrom: coords.chrom,
        start: coords.start,
        end: coords.end,
      });
      try {
        const details = await platform().genome.getFeatureDetails(
          fetchSessionId,
          {
            chrom: coords.chrom,
            start: coords.start,
            end: coords.end,
            featureId: selectedAnnotation.name,
            maxWindowBp: 500_000,
          },
          requestId
        );
        if (token !== featureDetailsTokenRef.current) return;
        featureDetailsPendingRequestRef.current = null;
        setFeatureDetailsState({ kind: 'ready', annotation: selectedAnnotation, details });
        recordEvent('feature-details-ready', {
          token,
          featureId: details.featureId ?? null,
          relatedCount: details.relatedFeatures.length,
          sourceRecordCount: details.sourceRecordCount,
          truncated: details.truncated,
        });
      } catch (err) {
        if (token !== featureDetailsTokenRef.current) return;
        featureDetailsPendingRequestRef.current = null;
        if (isGenomeRequestCancelled(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        setFeatureDetailsState({ kind: 'error', annotation: selectedAnnotation, message });
        recordEvent('feature-details-error', { token, message });
      }
    })();

    return () => {
      featureDetailsTokenRef.current += 1;
      cancelGenomeRequest(featureDetailsSessionRef.current ?? sessionId, requestId);
    };
  }, [
    assemblyRoutingEnabled,
    ensureAssemblySessionForChrom,
    manifestChrom,
    recordEvent,
    rendererAssembly,
    selectedAnnotation,
    sessionId,
  ]);

  return {
    selectedAnnotation,
    featureDetailsState,
    featureDetailsStateRef,
    handleSelectedAnnotationChange,
  };
}

function cancelGenomeRequest(sessionId: string | undefined, requestId: string | null | undefined) {
  if (!sessionId || !requestId) return;
  void Promise.resolve(platform().genome.cancelRequest(sessionId, requestId)).catch(
    () => undefined
  );
}

function isGenomeRequestCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
