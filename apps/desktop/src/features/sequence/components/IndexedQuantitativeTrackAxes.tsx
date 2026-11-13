import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { DEFAULT_QUANTITATIVE_TRACK_PRESENTATION } from '@waypoint/genome-data';
import { BUILTIN_TRACK_TYPES } from '@waypoint/genome-renderer';

import { LEGACY_BUCKET, useLaneContractStore, type Lane } from '../lane-contract-store';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import type { LaneBand, LaneScreenBands } from './lane-screen-bands';
import {
  QuantitativeTrackAxis,
  quantitativeAxisRangeFromDiagnostics,
  quantitativeAxisRangeFromPresentation,
  type QuantitativeAxisRange,
} from './QuantitativeTrackAxis';

const EMPTY_LANES: ReadonlyArray<Lane> = [];

export function isQuantitativeDataset(dataset: Lane['dataset']): boolean {
  return (
    dataset.kind !== 'pileup' &&
    (dataset.trackType === BUILTIN_TRACK_TYPES.quantitative ||
      dataset.trackType === BUILTIN_TRACK_TYPES.peak)
  );
}

export function IndexedQuantitativeTrackAxes({
  laneOwnerId,
  bands,
  rendererReadyEpoch,
  webglRef,
}: {
  laneOwnerId: string;
  bands: LaneScreenBands;
  rendererReadyEpoch: number;
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
}) {
  const ownedLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES
  );
  const legacyLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[LEGACY_BUCKET] ?? EMPTY_LANES
  );
  const quantitativeLanes = useMemo(
    () =>
      [...ownedLanes, ...legacyLanes].filter((lane) => {
        const presentation =
          lane.dataset.quantitativePresentation ?? DEFAULT_QUANTITATIVE_TRACK_PRESENTATION;
        return lane.visible && isQuantitativeDataset(lane.dataset) && presentation.showRange;
      }),
    [legacyLanes, ownedLanes]
  );
  const scrollLayerRef = useRef<HTMLDivElement | null>(null);
  const presentedScrollTopRef = useRef<number | null>(null);

  useEffect(() => {
    presentedScrollTopRef.current = null;
    if (quantitativeLanes.length === 0) return;

    let unsubscribe: (() => void) | undefined;
    let retryFrame: number | null = null;
    let disposed = false;
    const syncScroll = () => {
      const receipt = webglRef.current?.getLinearRenderer?.()?.getPresentedTrackScrollReceipt?.();
      const target = scrollLayerRef.current;
      if (!receipt || !target || presentedScrollTopRef.current === receipt.trackScrollTop) return;
      presentedScrollTopRef.current = receipt.trackScrollTop;
      target.style.transform = `translate3d(0, ${-receipt.trackScrollTop}px, 0)`;
    };
    const attach = () => {
      if (disposed) return;
      const map = webglRef.current;
      if (!map?.getLinearRenderer?.()) {
        retryFrame = requestAnimationFrame(attach);
        return;
      }
      syncScroll();
      unsubscribe = map.subscribeToPresentedFrames(syncScroll);
    };
    attach();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      unsubscribe?.();
    };
  }, [quantitativeLanes.length, rendererReadyEpoch, webglRef]);

  if (quantitativeLanes.length === 0) return null;

  return (
    <div
      data-testid="quantitative-y-axis-layer"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      <div
        ref={scrollLayerRef}
        data-testid="quantitative-y-axis-scroll-layer"
        className="absolute inset-0 will-change-transform"
      >
        {quantitativeLanes.map((lane) => {
          const band = bands.dataBounds[lane.dataset.trackId];
          if (!band) return null;
          return (
            <QuantitativeTrackAxisBand
              key={lane.dataset.trackId}
              band={band}
              lane={lane}
              rendererReadyEpoch={rendererReadyEpoch}
              webglRef={webglRef}
            />
          );
        })}
      </div>
    </div>
  );
}

function QuantitativeTrackAxisBand({
  band,
  lane,
  rendererReadyEpoch,
  webglRef,
}: {
  band: LaneBand;
  lane: Lane;
  rendererReadyEpoch: number;
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
}) {
  return (
    <div
      data-testid={`quantitative-y-axis-band-${lane.dataset.trackId}`}
      className="absolute left-0 right-0"
      style={{ top: band.topPx, height: band.heightPx }}
    >
      <RendererQuantitativeTrackAxis
        lane={lane}
        rendererReadyEpoch={rendererReadyEpoch}
        webglRef={webglRef}
      />
    </div>
  );
}

function RendererQuantitativeTrackAxis({
  lane,
  rendererReadyEpoch,
  webglRef,
}: {
  lane: Lane;
  rendererReadyEpoch: number;
  webglRef: RefObject<IndexedGenomeTileNativeMapHandle | null>;
}) {
  const { dataset } = lane;
  const presentation = dataset.quantitativePresentation ?? DEFAULT_QUANTITATIVE_TRACK_PRESENTATION;
  const expectedTransform = presentation.scale.transform;
  const fallback = useMemo(
    () => quantitativeAxisRangeFromPresentation(presentation, dataset.quantitativeSourceSummary),
    [dataset.quantitativeSourceSummary, presentation]
  );
  const [rendererRange, setRendererRange] = useState<QuantitativeAxisRange | null>(fallback);
  const displayedRange = rendererRange?.transform === expectedTransform ? rendererRange : fallback;

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let retryFrame: number | null = null;
    let disposed = false;
    const syncRange = () => {
      const diagnostics = webglRef.current
        ?.getLinearRenderer?.()
        ?.getTrackDiagnostics(dataset.trackId);
      const next =
        quantitativeAxisRangeFromDiagnostics(
          diagnostics,
          expectedTransform,
          presentation.scale.mode
        ) ?? fallback;
      setRendererRange((current) => (quantitativeAxisRangesEqual(current, next) ? current : next));
    };
    const attach = () => {
      if (disposed) return;
      const map = webglRef.current;
      if (!map?.getLinearRenderer?.()) {
        retryFrame = requestAnimationFrame(attach);
        return;
      }
      syncRange();
      unsubscribe = map.subscribeToPresentedFrames(syncRange);
    };
    attach();
    return () => {
      disposed = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      unsubscribe?.();
    };
  }, [
    dataset.trackId,
    expectedTransform,
    fallback,
    presentation.scale.mode,
    rendererReadyEpoch,
    webglRef,
  ]);

  return displayedRange ? (
    <QuantitativeTrackAxis trackId={dataset.trackId} label={dataset.label} range={displayedRange} />
  ) : null;
}

function quantitativeAxisRangesEqual(
  left: QuantitativeAxisRange | null,
  right: QuantitativeAxisRange | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.min === right.min &&
      left.max === right.max &&
      left.transform === right.transform)
  );
}
