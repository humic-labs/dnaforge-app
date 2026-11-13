import { useCallback, useEffect, useMemo, useRef } from 'react';

import type {
  PileupTrackData,
  QuantitativeBin,
  PileupReferenceInterval,
} from '@waypoint/genome-data';

import {
  experimentalHybridDefinition,
  ExperimentalHybridPileupPublisher,
} from '../experimental-hybrid-pileup';
import type { ActiveStressDataset } from '../lane-contract-store';
import type { UcscRenderableRecord } from '../ucsc-tile-types';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';

export interface IndexedExperimentalHybridPileupController {
  publishAlignment(trackId: string, data: PileupTrackData): void;
  publishHistogramPendingIntervals(
    trackId: string,
    intervals: ReadonlyArray<PileupReferenceInterval>
  ): void;
  publishQuantitative(
    trackId: string,
    records: ReadonlyArray<UcscRenderableRecord>,
    revision: string
  ): void;
  noteLaneContractWired(): void;
}

export function useExperimentalHybridPileupStreaming(input: {
  readonly webglRef: { readonly current: IndexedGenomeTileNativeMapHandle | null };
  readonly activeStressDatasets: ReadonlyArray<ActiveStressDataset>;
}): IndexedExperimentalHybridPileupController {
  const definitions = useMemo(
    () =>
      input.activeStressDatasets.flatMap((dataset) => {
        const definition = experimentalHybridDefinition(dataset);
        return definition ? [definition] : [];
      }),
    [input.activeStressDatasets]
  );
  const publisherRef = useRef<ExperimentalHybridPileupPublisher | null>(null);
  if (!publisherRef.current) {
    publisherRef.current = new ExperimentalHybridPileupPublisher({
      definitions: [],
      target: {
        getRenderer: () => input.webglRef.current?.getLinearRenderer?.() ?? null,
        requestRender: () => input.webglRef.current?.requestRender?.(),
      },
    });
  }

  useEffect(() => {
    publisherRef.current?.updateDefinitions(definitions);
  }, [definitions]);

  const publishAlignment = useCallback((trackId: string, data: PileupTrackData) => {
    publisherRef.current?.publishAlignment(trackId, data);
  }, []);
  const publishQuantitative = useCallback(
    (trackId: string, records: ReadonlyArray<UcscRenderableRecord>, revision: string) => {
      const quantitative = records.filter(
        (record): record is QuantitativeBin => 'value' in record && Number.isFinite(record.value)
      );
      publisherRef.current?.publishQuantitative(trackId, quantitative, revision);
    },
    []
  );
  const noteLaneContractWired = useCallback(() => publisherRef.current?.replay(), []);
  const publishHistogramPendingIntervals = useCallback(
    (trackId: string, intervals: ReadonlyArray<PileupReferenceInterval>) => {
      publisherRef.current?.publishHistogramPendingIntervals(trackId, intervals);
    },
    []
  );

  return useMemo(
    () => ({
      publishAlignment,
      publishQuantitative,
      publishHistogramPendingIntervals,
      noteLaneContractWired,
    }),
    [noteLaneContractWired, publishAlignment, publishQuantitative, publishHistogramPendingIntervals]
  );
}
